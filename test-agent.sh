#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$PROJECT_DIR/finmolt-api"
AGENT_DIR="$PROJECT_DIR/finmolt-agent"

# ── 配置（在这里输入自己的测试账号 API Key） ──
FINMOLT_API_KEY="${FINMOLT_API_KEY:-finmolt_test_quantbot}"
ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-sk-qoJNutgo2ueJXs8UA8Q6XDbNlXztuN0uvthfjiWqN0ZhJk9e}"
ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://codeflow.asia}"
AGENT_MODE="${AGENT_MODE:-tool-use}"
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL:-2}"
MAX_ITERATIONS="${MAX_ITERATIONS:-10}"

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[TEST]${NC} $*"; }
err()  { echo -e "${RED}[FAIL]${NC} $*"; }
step() { echo -e "\n${CYAN}── $* ──${NC}"; }

API_URL="http://localhost:3001/api/v1"

# ── 1. 检查 API 是否运行 ──
step "检查 API 服务"
if curl -s --connect-timeout 3 "$API_URL/polymarket/tags?limit=1" | grep -q '"label"'; then
    log "API 已运行 ✓"
else
    err "API 未运行，正在启动..."
    # 加载 API .env
    if [[ -f "$API_DIR/.env" ]]; then
        set -a; source "$API_DIR/.env"; set +a
    fi
    cd "$API_DIR" && PORT=3001 node src/index.js &
    API_PID=$!
    echo "$API_PID" > /tmp/finmolt_test_api.pid
    sleep 4
    if curl -s --connect-timeout 3 "$API_URL/polymarket/tags?limit=1" | grep -q '"label"'; then
        log "API 启动成功 ✓"
    else
        err "API 启动失败，请手动运行 ./start.sh --no-agent"
        exit 1
    fi
fi

# ── 2. 检查数据 ──
step "检查 Polymarket 数据"
MARKET_COUNT=$(curl -s "$API_URL/polymarket/events?limit=5" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    markets=[m for e in d.get('data',[]) for m in e.get('markets',[]) if m.get('bestAsk')]
    print(len(markets))
except: print(0)
" 2>/dev/null || echo "0")

if [[ "$MARKET_COUNT" -gt 0 ]]; then
    log "有 $MARKET_COUNT 个带价格的市场 ✓"
else
    err "没有带价格的市场数据，先运行同步："
    err "  cd finmolt-api && node scripts/sync_polymarket.js && node scripts/sync_prices.js"
    exit 1
fi

# ── 3. 验证测试账号 ──
step "验证测试账号"
LOGIN_RESULT=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "{\"apiKey\":\"$FINMOLT_API_KEY\"}" "$API_URL/auth/login")

if echo "$LOGIN_RESULT" | grep -q '"name"'; then
    AGENT_NAME=$(echo "$LOGIN_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['name'])" 2>/dev/null)
    log "登录成功: $AGENT_NAME ✓"
else
    err "登录失败，检查 FINMOLT_API_KEY"
    echo "$LOGIN_RESULT"
    exit 1
fi

# ── 4. 查看交易前 Portfolio ──
step "交易前 Portfolio"
curl -s -H "Authorization: Bearer $FINMOLT_API_KEY" \
    "$API_URL/trading/portfolio" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f\"  余额: {d['balance']} USDC\")
print(f\"  持仓数: {len(d['positions'])}\")
print(f\"  总值: {d['summary']['totalValue']} USDC\")
" 2>/dev/null || echo "  (无法解析)"

# ── 5. 启动 Agent ──
step "启动 Agent Bot [mode=$AGENT_MODE, max_iterations=$MAX_ITERATIONS]"
echo ""
echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Agent 日志开始（按 Ctrl+C 停止）${NC}"
echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo ""

cd "$AGENT_DIR"
exec env \
    FINMOLT_API_KEY="$FINMOLT_API_KEY" \
    ANTHROPIC_API_KEY="$ANTHROPIC_AUTH_TOKEN" \
    ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN" \
    ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" \
    AGENT_MODE="$AGENT_MODE" \
    HEARTBEAT_INTERVAL="$HEARTBEAT_INTERVAL" \
    MAX_ITERATIONS="$MAX_ITERATIONS" \
    node bot.js
