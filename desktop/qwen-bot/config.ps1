# Qwen / llama.cpp profile for the RCS group-chat bot (optional local model).
# Own port, own API key, localhost-only bind (Tailscale Funnel proxies to it).
# Needs ~24 GB VRAM (e.g. an RTX 3090/4090); stop other llama-servers first.
# Edit $ModelPath and $MmprojPath below.

$ModelPath  = "C:\models\Qwen3.8-27B-Q4_K_M.gguf"   # EDIT: your GGUF path
$ModelAlias = "qwen3.8-27b"

# Vision projector (Qwen3.8-27B is natively multimodal; llama.cpp needs this to accept images)
$MmprojPath = "$PSScriptRoot\mmproj-Qwen3.8-27B-f16.gguf"

# Network (Funnel only proxies to localhost)
$HostAddress = "127.0.0.1"
$Port        = 18081

# Model/runtime: chat needs less context than coding. 131072 / 2 slots = 64k per request.
# Keep the bot's MODEL_CONTEXT_WINDOW (Vercel env) a bit under the per-slot size.
$ContextSize   = 131072
$Parallel      = 2
$GpuLayers     = "all"
$FlashAttention = "on"

# Free the GPU when the chat goes quiet: after this many idle seconds the server
# unloads the model (VRAM back to ~0; /health still answers, so the bot keeps
# routing to Qwen) and reloads it on the next request, which then takes 30-50 s
# longer. Loaded, the model holds ~21 GB even when idle, which a game or any
# other GPU work on the PC would otherwise go without. 10 min outlasts a group
# chat's lulls. -1 = never sleep.
$SleepIdleSeconds = 600

# Most tokens one reply may generate, reasoning included. The bot sends no
# max_tokens, and a reply that gets stuck reasoning would otherwise run to the
# slot's full context (~30 min) and hold up the chat: a runaway doesn't error,
# so the fallback to Claude never fires. Normal replies are ~1,500 tokens;
# 8192 is ~4 min at 35 tok/s on a 3090. -1 = no cap.
$MaxTokens = 8192

# Qwen3.8 thinking-mode sampling (recommended settings)
$Temperature     = 1.0
$TopP            = 0.95
$TopK            = 20
$MinP            = 0.0
$PresencePenalty = 0.0
$RepeatPenalty   = 1.0

# Reasoning: template decides; the bot sends reasoning_effort per request.
$Reasoning       = "auto"
$ReasoningEffort = "default"

# KV cache
$CacheTypeK = "q8_0"
$CacheTypeV = "q8_0"

# Authentication (bot-only key)
$ApiKeyFile = "$PSScriptRoot\api-key.txt"

# Monitoring / logs
$EnableMetrics = $true
$LogFile       = "$PSScriptRoot\logs\llama-server.log"

# Scheduled task that hosts the server (survives SSH disconnects)
$TaskName = "QwenBot"

# Seconds to wait before relaunching llama-server after it exits/crashes
$RestartDelaySeconds = 30
