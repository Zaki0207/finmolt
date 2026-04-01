#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$PROJECT_DIR/finmolt-api"
WEB_DIR="$PROJECT_DIR/finmolt-web"
AGENT_DIR="$PROJECT_DIR/finmolt-agent"

API_PORT=3001
WEB_PORT=3000
PID_DIR="$PROJECT_DIR/.pids"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[FinMolt]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}   $*"; }
err()  { echo -e "${RED}[ERROR]${NC}  $*"; }
step() { echo -e "\n${CYAN}──${NC} $*"; }

# ─── 命令行选项 ───
SKIP_AGENT=false
SKIP_POLYMARKET=false
for arg in "$@"; do
    case "$arg" in
        --no-agent)       SKIP_AGENT=true ;;
        --no-polymarket)  SKIP_POLYMARKET=true ;;
        --help|-h)
            echo "Usage: $0 [--no-agent] [--no-polymarket]"
            exit 0 ;;
    esac
done

# ─── 加载 API .env ───
if [[ -f "$API_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$API_DIR/.env"
    set +a
fi
DB_URL="${DATABASE_URL:-postgresql://localhost:5432/finmolt}"
DB_NAME="${DB_URL##*/}"

# ─── 清理函数 ───
kill_service() {
    local pidfile=$1 name=$2
    if [[ -f "$pidfile" ]]; then
        local pid
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            pkill -TERM -P "$pid" 2>/dev/null || true
            kill -TERM "$pid" 2>/dev/null || true
            log "$name 已停止"
        fi
        rm -f "$pidfile"
    fi
}

_CLEANED=false
cleanup() {
    [[ "$_CLEANED" == true ]] && return
    _CLEANED=true
    echo ""
    log "正在停止所有服务..."
    kill_service "$PID_DIR/prices.pid"     "CLOB Price Sync"
    kill_service "$PID_DIR/polymarket.pid" "Polymarket Sync"
    kill_service "$PID_DIR/agent.pid"      "Agent Bot"
    kill_service "$PID_DIR/web.pid"        "Web"
    kill_service "$PID_DIR/api.pid"        "API"
    rm -rf "$PID_DIR"
    log "全部清理完成"
}
trap cleanup EXIT SIGINT SIGTERM

# ─── 工具函数 ───
check_port() {
    local port=$1 name=$2
    if lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null; then
        err "端口 $port 已被占用 ($name)"
        err "  查看占用: lsof -iTCP:$port -sTCP:LISTEN"
        return 1
    fi
}

wait_for_service() {
    local url=$1 name=$2 max_wait=${3:-30}
    local i=0
    while [[ $i -lt $max_wait ]]; do
        if curl -s --connect-timeout 2 --max-time 3 "$url" &>/dev/null; then
            return 0
        fi
        sleep 1
        (( i++ ))
    done
    err "$name 在 ${max_wait}s 内未就绪"
    return 1
}

ensure_deps() {
    local dir=$1 name=$2
    if [[ ! -d "$dir/node_modules" ]]; then
        log "安装 $name 依赖..."
        (cd "$dir" && npm install --silent) || { err "$name 依赖安装失败"; return 1; }
        log "$name 依赖已就绪 ✓"
    fi
}

# ═══════════════════════════════════════════════════════
main() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║        FinMolt 一键启动脚本          ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
    echo ""

    # ─── 1. 前置检查 ───
    step "检查运行环境"
    command -v node &>/dev/null || { err "未找到 node，请先安装 Node.js >= 18"; exit 1; }
    command -v psql &>/dev/null || { err "未找到 psql，请先安装 PostgreSQL"; exit 1; }
    command -v lsof &>/dev/null || { err "未找到 lsof（brew install lsof）"; exit 1; }

    NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
    if [[ "$NODE_MAJOR" -lt 18 ]]; then
        err "Node.js 需要 >= 18，当前: $(node -v)"
        exit 1
    fi
    log "Node.js $(node -v) ✓"

    check_port $API_PORT "API" || exit 1
    check_port $WEB_PORT "Web" || exit 1

    rm -rf "$PID_DIR"
    mkdir -p "$PID_DIR"

    # ─── 2. 安装依赖（先装，后面脚本才能跑）───
    step "安装 npm 依赖"
    ensure_deps "$API_DIR" "finmolt-api" || exit 1
    ensure_deps "$WEB_DIR" "finmolt-web" || exit 1
    if [[ "$SKIP_AGENT" == false && -d "$AGENT_DIR" ]]; then
        ensure_deps "$AGENT_DIR" "finmolt-agent" || SKIP_AGENT=true
    fi

    # ─── 3. 数据库初始化 ───
    step "检查数据库 ($DB_NAME)"
    if ! psql "$DB_URL" -c "SELECT 1" &>/dev/null; then
        warn "数据库 '$DB_NAME' 不存在，正在创建..."
        createdb "$DB_NAME" 2>/dev/null || true
        log "初始化核心表结构..."
        (cd "$API_DIR" && npm run db:migrate --silent && npm run db:seed --silent)
        log "数据库初始化完成 ✓"
    else
        log "数据库连接正常 ✓"
    fi

    # ─── 4. 迁移（幂等） ───
    step "执行数据库迁移"
    if [[ "$SKIP_POLYMARKET" == false ]]; then
        if (cd "$API_DIR" && npm run polymarket:migrate --silent 2>&1); then
            log "Polymarket 表 ✓"
        else
            warn "Polymarket 表迁移失败，将跳过同步"
            SKIP_POLYMARKET=true
        fi
    fi

    if (cd "$API_DIR" && npm run trading:migrate --silent 2>&1); then
        log "Trading 表 ✓"
    else
        warn "Trading 表迁移失败，交易模拟功能可能不可用"
    fi

    # ─── 5. 数据同步（一次性，确保启动时有最新数据）───
    if [[ "$SKIP_POLYMARKET" == false ]]; then
        step "同步 Polymarket 市场数据"
        if (cd "$API_DIR" && node scripts/sync_polymarket.js); then
            log "市场数据同步完成 ✓"
        else
            warn "市场数据同步失败，前端可能显示旧数据"
        fi

        step "同步 CLOB 实时价格"
        if (cd "$API_DIR" && node scripts/sync_prices.js); then
            log "价格同步完成 ✓"
        else
            warn "价格同步失败，市场价格暂时不可用"
        fi
    fi

    # ─── 6. 启动 API ───
    step "启动服务"
    log "启动后端 API (port $API_PORT)..."
    (cd "$API_DIR" && PORT=$API_PORT npm run dev > "$PID_DIR/api.log" 2>&1) &
    echo $! > "$PID_DIR/api.pid"

    if ! wait_for_service "http://localhost:$API_PORT/health" "API" 30; then
        err "API 启动失败，查看日志: tail -f $PID_DIR/api.log"
        cleanup; exit 1
    fi
    log "API 已就绪 ✓"

    # ─── 7. 启动前端 ───
    log "启动前端 Web (port $WEB_PORT)..."
    (cd "$WEB_DIR" && npm run dev -- -p $WEB_PORT > "$PID_DIR/web.log" 2>&1) &
    echo $! > "$PID_DIR/web.pid"

    if ! wait_for_service "http://localhost:$WEB_PORT" "Web" 120; then
        warn "前端编译中，请稍后访问 http://localhost:$WEB_PORT"
    else
        log "前端已就绪 ✓"
    fi

    # ─── 8. 后台常驻同步进程 ───
    if [[ "$SKIP_POLYMARKET" == false ]]; then
        POLYMARKET_SYNC_INTERVAL_MS="${POLYMARKET_SYNC_INTERVAL_MS:-600000}"
        log "启动 Polymarket 同步 (每 $((POLYMARKET_SYNC_INTERVAL_MS / 1000))s)..."
        (cd "$API_DIR" && POLYMARKET_SYNC_INTERVAL_MS="$POLYMARKET_SYNC_INTERVAL_MS" \
            node scripts/sync_polymarket.js --watch > "$PID_DIR/polymarket.log" 2>&1) &
        echo $! > "$PID_DIR/polymarket.pid"

        PRICES_SYNC_INTERVAL_MS="${PRICES_SYNC_INTERVAL_MS:-120000}"
        log "启动 CLOB 价格同步 (每 $((PRICES_SYNC_INTERVAL_MS / 1000))s)..."
        (cd "$API_DIR" && PRICES_SYNC_INTERVAL_MS="$PRICES_SYNC_INTERVAL_MS" \
            node scripts/sync_prices.js --watch > "$PID_DIR/prices.log" 2>&1) &
        echo $! > "$PID_DIR/prices.pid"
        log "后台同步进程已启动 ✓"
    fi

    # ─── 9. 启动 Agent Bot（可选）───
    AGENT_STARTED=false
    if [[ "$SKIP_AGENT" == false && -d "$AGENT_DIR" ]]; then
        FINMOLT_API_KEY="${FINMOLT_API_KEY:-}"
        if [[ -z "$FINMOLT_API_KEY" && -f "$HOME/.config/finmolt/credentials.json" ]]; then
            FINMOLT_API_KEY=$(node -e "
                try { const c = require('$HOME/.config/finmolt/credentials.json');
                      process.stdout.write(c.apiKey || ''); } catch { process.stdout.write(''); }
            " 2>/dev/null || true)
        fi

        ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
        OPENAI_API_KEY="${OPENAI_API_KEY:-}"
        LLM_PROVIDER="${LLM_PROVIDER:-anthropic}"
        HAS_LLM_KEY=false
        [[ -n "$ANTHROPIC_API_KEY" ]] && HAS_LLM_KEY=true && LLM_PROVIDER="anthropic"
        [[ -n "$OPENAI_API_KEY"    ]] && HAS_LLM_KEY=true && LLM_PROVIDER="openai"

        if [[ -n "$FINMOLT_API_KEY" && "$HAS_LLM_KEY" == true ]]; then
            log "启动 Agent Bot..."
            (cd "$AGENT_DIR" && FINMOLT_API_KEY="$FINMOLT_API_KEY" \
                ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
                OPENAI_API_KEY="$OPENAI_API_KEY" \
                LLM_PROVIDER="$LLM_PROVIDER" \
                node bot.js > "$PID_DIR/agent.log" 2>&1) &
            echo $! > "$PID_DIR/agent.pid"
            AGENT_STARTED=true
            log "Agent Bot 已启动 ✓"
        else
            warn "Agent Bot 未启动（缺少环境变量）"
            [[ -z "$FINMOLT_API_KEY" ]] && warn "  缺少 FINMOLT_API_KEY — 先运行: cd finmolt-agent && node register.js"
            [[ "$HAS_LLM_KEY" != true ]] && warn "  缺少 ANTHROPIC_API_KEY 或 OPENAI_API_KEY"
        fi
    fi

    # ─── 完成 ───
    echo ""
    echo -e "${CYAN}══════════════════════════════════════${NC}"
    log "所有服务已启动！"
    echo ""
    echo -e "  ${GREEN}前端${NC}      http://localhost:$WEB_PORT"
    echo -e "  ${GREEN}API${NC}       http://localhost:$API_PORT"
    if [[ "$SKIP_POLYMARKET" == false ]]; then
        echo -e "  ${GREEN}市场同步${NC}  每 $((POLYMARKET_SYNC_INTERVAL_MS / 1000))s"
        echo -e "  ${GREEN}价格同步${NC}  每 $((PRICES_SYNC_INTERVAL_MS / 1000))s (CLOB)"
    fi
    [[ "$AGENT_STARTED" == true ]] && echo -e "  ${GREEN}Agent Bot${NC} 运行中"
    echo ""
    echo -e "  日志目录: $PID_DIR/"
    echo -e "  按 ${YELLOW}Ctrl+C${NC} 停止所有服务"
    echo -e "${CYAN}══════════════════════════════════════${NC}"
    echo ""

    # 保持前台，等待任意子进程退出
    wait -n 2>/dev/null && warn "某个服务已退出，按 Ctrl+C 停止全部" && wait || wait
}

main "$@"
