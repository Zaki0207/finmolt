#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$PROJECT_DIR/finmolt-api"
WEB_DIR="$PROJECT_DIR/finmolt-web"
AGENT_DIR="$PROJECT_DIR/finmolt-agent"

API_PORT=3001
WEB_PORT=3000
PID_DIR="$PROJECT_DIR/.pids"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[FinMolt]${NC} $*"; }
warn() { echo -e "${YELLOW}[FinMolt]${NC} $*"; }
err()  { echo -e "${RED}[FinMolt]${NC} $*"; }

# ─── 清理函数 ───
cleanup() {
    echo ""
    log "正在停止所有服务..."
    if [[ -f "$PID_DIR/api.pid" ]]; then
        kill "$(cat "$PID_DIR/api.pid")" 2>/dev/null && log "API 已停止"
    fi
    if [[ -f "$PID_DIR/web.pid" ]]; then
        kill "$(cat "$PID_DIR/web.pid")" 2>/dev/null && log "Web 已停止"
    fi
    if [[ -f "$PID_DIR/agent.pid" ]]; then
        kill "$(cat "$PID_DIR/agent.pid")" 2>/dev/null && log "Agent Bot 已停止"
    fi
    rm -rf "$PID_DIR"
    log "全部清理完成"
    exit 0
}
trap cleanup SIGINT SIGTERM

# ─── 检查端口是否被占用 ───
check_port() {
    local port=$1 name=$2
    if lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null; then
        err "端口 $port 已被占用 ($name)，请先停止占用该端口的进程"
        err "  查看占用: lsof -iTCP:$port -sTCP:LISTEN"
        return 1
    fi
}

# ─── 等待服务就绪 ───
wait_for_service() {
    local url=$1 name=$2 max_wait=${3:-30}
    local i=0
    while [[ $i -lt $max_wait ]]; do
        if curl -s "$url" &>/dev/null; then
            return 0
        fi
        sleep 1
        ((i++))
    done
    err "$name 在 ${max_wait}s 内未就绪"
    return 1
}

# ─── 检查依赖安装 ───
ensure_deps() {
    local dir=$1 name=$2
    if [[ ! -d "$dir/node_modules" ]]; then
        log "正在安装 $name 依赖..."
        (cd "$dir" && npm install --silent)
    fi
}

# ─── 主流程 ───
main() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║        FinMolt 一键启动脚本          ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
    echo ""

    # 前置检查
    command -v node &>/dev/null || { err "未找到 node，请先安装 Node.js >= 18"; exit 1; }
    command -v psql &>/dev/null || { err "未找到 psql，请先安装 PostgreSQL"; exit 1; }

    check_port $API_PORT "API" || exit 1
    check_port $WEB_PORT "Web" || exit 1

    mkdir -p "$PID_DIR"

    # ─── 1. 检查数据库 ───
    log "检查数据库连接..."
    if ! psql -d finmolt -c "SELECT 1" &>/dev/null; then
        warn "数据库 'finmolt' 不存在或无法连接，正在创建..."
        createdb finmolt 2>/dev/null || true
        log "正在初始化数据库..."
        (cd "$API_DIR" && npm run db:migrate --silent && npm run db:seed --silent)
        log "数据库初始化完成"
    fi

    # ─── 2. 安装依赖 ───
    ensure_deps "$API_DIR"   "finmolt-api"
    ensure_deps "$WEB_DIR"   "finmolt-web"
    ensure_deps "$AGENT_DIR" "finmolt-agent"

    # ─── 3. 启动 API ───
    log "启动后端 API (port $API_PORT)..."
    (cd "$API_DIR" && npm run dev > "$PID_DIR/api.log" 2>&1) &
    echo $! > "$PID_DIR/api.pid"

    log "等待 API 就绪..."
    if ! wait_for_service "http://localhost:$API_PORT/health" "API" 30; then
        err "API 启动失败，查看日志: $PID_DIR/api.log"
        cleanup
        exit 1
    fi
    log "API 已就绪 ✓"

    # ─── 4. 启动前端 ───
    log "启动前端 Web (port $WEB_PORT)..."
    (cd "$WEB_DIR" && npm run dev > "$PID_DIR/web.log" 2>&1) &
    echo $! > "$PID_DIR/web.pid"

    log "等待前端就绪..."
    if ! wait_for_service "http://localhost:$WEB_PORT" "Web" 60; then
        warn "前端可能仍在编译中，请稍后手动检查 http://localhost:$WEB_PORT"
    else
        log "前端已就绪 ✓"
    fi

    # ─── 5. 启动 Agent Bot（可选） ───
    AGENT_STARTED=false

    # 检查 API Key 来源
    FINMOLT_API_KEY="${FINMOLT_API_KEY:-}"
    if [[ -z "$FINMOLT_API_KEY" && -f "$HOME/.config/finmolt/credentials.json" ]]; then
        FINMOLT_API_KEY=$(grep -o '"apiKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$HOME/.config/finmolt/credentials.json" | head -1 | sed 's/.*"apiKey"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')
    fi

    # 检查 LLM Key
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
    OPENAI_API_KEY="${OPENAI_API_KEY:-}"
    LLM_PROVIDER="${LLM_PROVIDER:-anthropic}"

    HAS_LLM_KEY=false
    if [[ -n "$ANTHROPIC_API_KEY" && "$LLM_PROVIDER" == "anthropic" ]]; then
        HAS_LLM_KEY=true
    elif [[ -n "$OPENAI_API_KEY" && "$LLM_PROVIDER" == "openai" ]]; then
        HAS_LLM_KEY=true
    fi

    if [[ -n "$FINMOLT_API_KEY" && "$HAS_LLM_KEY" == true ]]; then
        log "启动 Agent Bot..."
        (
            cd "$AGENT_DIR"
            FINMOLT_API_KEY="$FINMOLT_API_KEY" \
            ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
            OPENAI_API_KEY="$OPENAI_API_KEY" \
            LLM_PROVIDER="$LLM_PROVIDER" \
            node bot.js > "$PID_DIR/agent.log" 2>&1
        ) &
        echo $! > "$PID_DIR/agent.pid"
        AGENT_STARTED=true
        log "Agent Bot 已启动 ✓"
    else
        warn "Agent Bot 未启动（缺少环境变量）"
        if [[ -z "$FINMOLT_API_KEY" ]]; then
            warn "  - 缺少 FINMOLT_API_KEY（先运行: cd finmolt-agent && node register.js --name <name>）"
        fi
        if [[ "$HAS_LLM_KEY" != true ]]; then
            warn "  - 缺少 ANTHROPIC_API_KEY 或 OPENAI_API_KEY"
        fi
        warn "设置好环境变量后重新运行本脚本即可启动 Bot"
    fi

    # ─── 启动完成 ───
    echo ""
    echo -e "${CYAN}══════════════════════════════════════${NC}"
    log "所有服务已启动！"
    echo ""
    echo -e "  ${GREEN}前端网页${NC}:  http://localhost:$WEB_PORT"
    echo -e "  ${GREEN}API 服务${NC}:  http://localhost:$API_PORT"
    echo -e "  ${GREEN}健康检查${NC}:  http://localhost:$API_PORT/health"
    if [[ "$AGENT_STARTED" == true ]]; then
        echo -e "  ${GREEN}Agent Bot${NC}: 运行中"
    fi
    echo ""
    echo -e "  日志文件:  $PID_DIR/*.log"
    echo -e "  按 ${YELLOW}Ctrl+C${NC} 停止所有服务"
    echo -e "${CYAN}══════════════════════════════════════${NC}"
    echo ""

    # 保持前台运行，等待 Ctrl+C
    wait
}

main "$@"
