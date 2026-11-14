package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Store holds everything the connector needs to persist or share:
// the (encrypted) libgm session, dedup/echo sets, the reply outbox and the
// single-instance lease. Redis in production (Vercel Daemon has no persistent
// disk); file + memory for local development.
type Store interface {
	LoadSession(ctx context.Context) ([]byte, error) // nil, nil when absent
	SaveSession(ctx context.Context, data []byte) error
	// FirstSeen returns true the first time an ID is marked.
	FirstSeen(ctx context.Context, kind, id string, ttl time.Duration) (bool, error)
	Has(ctx context.Context, kind, id string) (bool, error)
	PopOutbox(ctx context.Context, timeout time.Duration) ([]byte, error) // nil, nil on timeout
	PushOutbox(ctx context.Context, item []byte) error
	// SetKey writes <prefix>:<suffix> (ttl 0 = no expiry). Used for heartbeat,
	// state, and RPC replies the agent polls for.
	SetKey(ctx context.Context, suffix string, value []byte, ttl time.Duration) error
	GetKey(ctx context.Context, suffix string) ([]byte, error) // nil, nil when absent
	AcquireLease(ctx context.Context, owner string, ttl time.Duration) (bool, error)
	RenewLease(ctx context.Context, owner string, ttl time.Duration) (bool, error)
	ReleaseLease(ctx context.Context, owner string)
}

// ---- encryption ---------------------------------------------------------

type sealer struct{ aead cipher.AEAD }

func newSealer(b64Key string) (*sealer, error) {
	if b64Key == "" {
		return nil, nil
	}
	key, err := base64.StdEncoding.DecodeString(b64Key)
	if err != nil || len(key) != 32 {
		return nil, errors.New("SESSION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &sealer{aead}, nil
}

func (s *sealer) seal(plain []byte) []byte {
	if s == nil {
		return plain
	}
	nonce := make([]byte, s.aead.NonceSize())
	_, _ = rand.Read(nonce)
	return append([]byte("enc1:"), s.aead.Seal(nonce, nonce, plain, nil)...)
}

func (s *sealer) open(data []byte) ([]byte, error) {
	const prefix = "enc1:"
	if len(data) < len(prefix) || string(data[:len(prefix)]) != prefix {
		if s != nil {
			return nil, errors.New("stored session is not encrypted but SESSION_KEY is set; re-pair")
		}
		return data, nil
	}
	if s == nil {
		return nil, errors.New("stored session is encrypted; set SESSION_KEY")
	}
	data = data[len(prefix):]
	ns := s.aead.NonceSize()
	if len(data) < ns {
		return nil, errors.New("ciphertext too short")
	}
	return s.aead.Open(nil, data[:ns], data[ns:], nil)
}

// ---- Redis store --------------------------------------------------------

type redisStore struct {
	rdb    *redis.Client
	prefix string
	seal   *sealer
}

func newRedisStore(url, prefix string, seal *sealer) (*redisStore, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	return &redisStore{rdb: redis.NewClient(opts), prefix: prefix, seal: seal}, nil
}

func (r *redisStore) k(parts ...string) string {
	key := r.prefix
	for _, p := range parts {
		key += ":" + p
	}
	return key
}

func (r *redisStore) LoadSession(ctx context.Context) ([]byte, error) {
	data, err := r.rdb.Get(ctx, r.k("session")).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	return r.seal.open(data)
}

func (r *redisStore) SaveSession(ctx context.Context, data []byte) error {
	return r.rdb.Set(ctx, r.k("session"), r.seal.seal(data), 0).Err()
}

func (r *redisStore) FirstSeen(ctx context.Context, kind, id string, ttl time.Duration) (bool, error) {
	return r.rdb.SetNX(ctx, r.k(kind, id), 1, ttl).Result()
}

func (r *redisStore) Has(ctx context.Context, kind, id string) (bool, error) {
	n, err := r.rdb.Exists(ctx, r.k(kind, id)).Result()
	return n > 0, err
}

func (r *redisStore) PopOutbox(ctx context.Context, timeout time.Duration) ([]byte, error) {
	res, err := r.rdb.BRPop(ctx, timeout, r.k("outbox")).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	return []byte(res[1]), nil
}

func (r *redisStore) PushOutbox(ctx context.Context, item []byte) error {
	return r.rdb.LPush(ctx, r.k("outbox"), item).Err()
}

func (r *redisStore) SetKey(ctx context.Context, suffix string, value []byte, ttl time.Duration) error {
	return r.rdb.Set(ctx, r.k(suffix), value, ttl).Err()
}

func (r *redisStore) GetKey(ctx context.Context, suffix string) ([]byte, error) {
	data, err := r.rdb.Get(ctx, r.k(suffix)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	return data, err
}

func (r *redisStore) AcquireLease(ctx context.Context, owner string, ttl time.Duration) (bool, error) {
	return r.rdb.SetNX(ctx, r.k("lease"), owner, ttl).Result()
}

var renewScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`)

var releaseScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`)

func (r *redisStore) RenewLease(ctx context.Context, owner string, ttl time.Duration) (bool, error) {
	n, err := renewScript.Run(ctx, r.rdb, []string{r.k("lease")}, owner, ttl.Milliseconds()).Int()
	return n == 1, err
}

func (r *redisStore) ReleaseLease(ctx context.Context, owner string) {
	_ = releaseScript.Run(ctx, r.rdb, []string{r.k("lease")}, owner).Err()
}

// ---- local file/memory store (dev) ---------------------------------------

type localStore struct {
	path   string
	seal   *sealer
	mu     sync.Mutex
	seen   map[string]time.Time
	outbox chan []byte
}

func newLocalStore(dir string, seal *sealer) (*localStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &localStore{
		path:   filepath.Join(dir, "session.json"),
		seal:   seal,
		seen:   map[string]time.Time{},
		outbox: make(chan []byte, 100),
	}, nil
}

func (l *localStore) LoadSession(context.Context) ([]byte, error) {
	data, err := os.ReadFile(l.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	return l.seal.open(data)
}

func (l *localStore) SaveSession(_ context.Context, data []byte) error {
	tmp := l.path + ".tmp"
	if err := os.WriteFile(tmp, l.seal.seal(data), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, l.path)
}

func (l *localStore) FirstSeen(_ context.Context, kind, id string, ttl time.Duration) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := kind + ":" + id
	if exp, ok := l.seen[key]; ok && time.Now().Before(exp) {
		return false, nil
	}
	l.seen[key] = time.Now().Add(ttl)
	return true, nil
}

func (l *localStore) Has(_ context.Context, kind, id string) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	exp, ok := l.seen[kind+":"+id]
	return ok && time.Now().Before(exp), nil
}

func (l *localStore) PopOutbox(ctx context.Context, timeout time.Duration) ([]byte, error) {
	select {
	case item := <-l.outbox:
		return item, nil
	case <-time.After(timeout):
		return nil, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (l *localStore) PushOutbox(_ context.Context, item []byte) error {
	select {
	case l.outbox <- item:
		return nil
	default:
		return errors.New("outbox full")
	}
}

func (l *localStore) SetKey(_ context.Context, suffix string, value []byte, _ time.Duration) error {
	return os.WriteFile(filepath.Join(filepath.Dir(l.path), strings.ReplaceAll(suffix, ":", "_")), value, 0o600)
}

func (l *localStore) GetKey(_ context.Context, suffix string) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(filepath.Dir(l.path), strings.ReplaceAll(suffix, ":", "_")))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func (l *localStore) AcquireLease(context.Context, string, time.Duration) (bool, error) { return true, nil }
func (l *localStore) RenewLease(context.Context, string, time.Duration) (bool, error)   { return true, nil }
func (l *localStore) ReleaseLease(context.Context, string)                              {}
