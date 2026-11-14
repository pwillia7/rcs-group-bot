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
