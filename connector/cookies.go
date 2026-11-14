package main

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// parseCookies accepts either a JSON object of {name: value} or a cURL
// command copied from Chrome DevTools ("Copy as cURL (bash)") for any
// request to messages.google.com, and returns the cookie map.
func parseCookies(input string) (map[string]string, error) {
	input = strings.TrimSpace(input)
	if strings.HasPrefix(input, "{") {
		var m map[string]string
		if err := json.Unmarshal([]byte(input), &m); err != nil {
			return nil, err
		}
		return requireCookies(m)
	}
	// cURL: -b '...' / --cookie '...' / -H 'cookie: ...'
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?s)(?:-b|--cookie)\s+'([^']*)'`),
		regexp.MustCompile(`(?s)(?:-b|--cookie)\s+"([^"]*)"`),
		regexp.MustCompile(`(?is)-H\s+'cookie:\s*([^']*)'`),
		regexp.MustCompile(`(?is)-H\s+"cookie:\s*([^"]*)"`),
	}
	for _, re := range patterns {
		if m := re.FindStringSubmatch(input); m != nil {
			cookies := parseCookieHeader(m[1])
			// Allow extra "NAME=value" lines appended after the cURL command, e.g. the
			// messages.google.com-scoped OSID cookie copied from DevTools → Application.
			extra := regexp.MustCompile(`(?m)^\s*([A-Za-z0-9_-]+)=(\S+)\s*$`)
			for _, kv := range extra.FindAllStringSubmatch(input, -1) {
				cookies[kv[1]] = kv[2]
			}
			return requireCookies(cookies)
		}
	}
	// Bare "a=b; c=d" header value
	if strings.Contains(input, "=") && !strings.Contains(input, "curl") {
		return requireCookies(parseCookieHeader(input))
	}
	return nil, errors.New("could not find cookies: paste a JSON object or a 'Copy as cURL (bash)' command")
}

func parseCookieHeader(h string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(h, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && name != "" {
			out[name] = value
		}
	}
	return out
}

func requireCookies(m map[string]string) (map[string]string, error) {
	var missing []string
	for _, name := range []string{"SID", "HSID", "SSID", "OSID", "APISID", "SAPISID"} {
		if m[name] == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, errors.New("missing required Google cookies: " + strings.Join(missing, ", ") +
			" (copy the request from a messages.google.com tab while signed in)")
	}
	return m, nil
}
