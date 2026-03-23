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

# ─── 命令行选项 ───
SKIP_AGENT=false
SKIP_POLYMARKET=false
for arg in "$@"; do
    case "$arg" in
        --no-agent)        SKIP_AGENT=true ;;
        --no-polymarket)   SKIP_POLYMARKET=true ;;
        --help|-h)
            echo "Usage: $0 [--no-agent] [--no-polymarket]"
            exit 0 ;;
    esac
done

# ─── 加载 API .env（提取 DATABASE_URL 等）───
if [[ -f "$API_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$API_DIR/.env"
    set +a
fi
DB_URL="${DATABASE_URL:-postgresql://localhost:5432/finmolt}"
DB_NAME="${DB_URL##*/}"   # 取 URL 最后一段作为数据库名

# ─── 清理函数 ───
kill_service() {
    local pidfile=$1 name=$2
    if [[ -f "$pidfile" ]]; then
        local pid
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            # 先杀子进程，再杀父进程
            pkill -TERM -P "$pid" 2>/dev/null || true
            kill -TERM "$pid" 2>/dev/null || true
            log "$name 已停止"
        fi
        rm -f "$pidfile"
    fi
}

cleanup() {
    echo ""
    log "正在停止所有服务..."
    kill_service "$PID_DIR/polymarket.pid" "Polymarket Sync"
    kill_service "$PID_DIR/agent.pid"      "Agent Bot"
    kill_service "$PID_DIR/web.pid"        "Web"
    kill_service "$PID_DIR/api.pid"        "API"
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
        if curl -s --connect-timeout 2 --max-time 3 "$url" &>/dev/null; then
            return 0
        fi
        sleep 1
        (( i++ ))
    done
    err "$name 在 ${max_wait}s 内未就绪"
    return 1
}

# ─── 检查依赖安装 ───
ensure_deps() {
    local dir=$1 name=$2
    if [[ ! -d "$dir" ]]; then
        err "目录不存在: $dir"
        return 1
    fi
    if [[ ! -d "$dir/node_modules" ]]; then
        log "正在安装 $name 依赖..."
        (cd "$dir" && npm install --silent) || { err "$name 依赖安装失败"; return 1; }
    fi
}

# ─── 主流程 ───
main() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║        FinMolt 一键启动脚本          ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
    echo ""

    # ─── 前置检查 ───
    command -v node &>/dev/null || { err "未找到 node，请先安装 Node.js >= 18"; exit 1; }
    command -v psql &>/dev/null || { err "未找到 psql，请先安装 PostgreSQL"; exit 1; }
    command -v lsof &>/dev/null || { err "未找到 lsof，请先安装（brew install lsof）"; exit 1; }

    # Node.js 版本检查（要求 >= 18）
    NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
    if [[ "$NODE_MAJOR" -lt 18 ]]; then
        err "Node.js 版本需要 >= 18，当前: $(node -v)"
        exit 1
    fi

    check_port $API_PORT "API" || exit 1
    check_port $WEB_PORT "Web" || exit 1

    # 清理旧 PID 文件，重新建目录
    rm -rf "$PID_DIR"
    mkdir -p "$PID_DIR"

    # ─── 1. 检查数据库 ───
    log "检查数据库连接 ($DB_NAME)..."
    if ! psql "$DB_URL" -c "SELECT 1" &>/dev/null; then
        warn "数据库 '$DB_NAME' 不存在或无法连接，正在创建..."
        createdb "$DB_NAME" 2>/dev/null || true
        log "正在初始化数据库..."
        (cd "$API_DIR" && npm run db:migrate --silent && npm run db:seed --silent)
        log "数据库初始化完成"
    fi

    # Polymarket 表（幂等，ADD COLUMN IF NOT EXISTS）
    if [[ "$SKIP_POLYMARKET" == false ]]; then
        log "确保 Polymarket 表已创建..."
        if ! (cd "$API_DIR" && npm run polymarket:migrate --silent 2>&1); then
            warn "Polymarket 表初始化失败，将跳过同步服务"
            SKIP_POLYMARKET=true
        fi
    fi

    # 首次运行时预填充 Polymarket 数据（前端现在读本地 DB，空库会显示空页面）
    if [[ "$SKIP_POLYMARKET" == false ]]; then
        PM_COUNT=$(psql "$DB_URL" -t -c "SELECT COUNT(*) FROM polymarket_events" 2>/dev/null | tr -d ' \n' || echo "0")
        if [[ "$PM_COUNT" == "0" ]]; then
            log "Polymarket 数据库为空，执行初始同步（首次运行）..."
            if (cd "$API_DIR" && node scripts/sync_polymarket.js); then
                log "初始同步完成 ✓"
            else
                warn "初始同步失败，前端 Prediction Markets 页面可能暂时无数据"
            fi
        fi
    fi

    # ─── 2. 安装依赖 ───
    ensure_deps "$API_DIR" "finmolt-api"   || exit 1
    ensure_deps "$WEB_DIR" "finmolt-web"   || exit 1
    if [[ "$SKIP_AGENT" == false && -d "$AGENT_DIR" ]]; then
        ensure_deps "$AGENT_DIR" "finmolt-agent" || SKIP_AGENT=true
    fi

    # ─── 3. 启动 API ───
    log "启动后端 API (port $API_PORT)..."
    (cd "$API_DIR" && PORT=$API_PORT npm run dev > "$PID_DIR/api.log" 2>&1) &
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
    (cd "$WEB_DIR" && PORT=$WEB_PORT npm run dev > "$PID_DIR/web.log" 2>&1) &
    echo $! > "$PID_DIR/web.pid"

    log "等待前端就绪..."
    if ! wait_for_service "http://localhost:$WEB_PORT" "Web" 120; then
        warn "前端可能仍在编译中，请稍后手动检查 http://localhost:$WEB_PORT"
    else
        log "前端已就绪 ✓"
    fi

    # ─── 5. 启动 Polymarket 同步（后台常驻） ───
    if [[ "$SKIP_POLYMARKET" == false ]]; then
        POLYMARKET_SYNC_INTERVAL_MS="${POLYMARKET_SYNC_INTERVAL_MS:-600000}"
        log "启动 Polymarket 数据同步 (每 $((POLYMARKET_SYNC_INTERVAL_MS / 1000))s)..."
        (cd "$API_DIR" && POLYMARKET_SYNC_INTERVAL_MS="$POLYMARKET_SYNC_INTERVAL_MS" \
            node scripts/sync_polymarket.js --watch > "$PID_DIR/polymarket.log" 2>&1) &
        echo $! > "$PID_DIR/polymarket.pid"
        log "Polymarket Sync 已启动 ✓"
    else
        warn "Polymarket Sync 已跳过"
    fi

    # ─── 6. 启动 Agent Bot（可选） ───
    AGENT_STARTED=false

    if [[ "$SKIP_AGENT" == false && -d "$AGENT_DIR" ]]; then
        # 读取 API Key
        FINMOLT_API_KEY="${FINMOLT_API_KEY:-}"
        if [[ -z "$FINMOLT_API_KEY" && -f "$HOME/.config/finmolt/credentials.json" ]]; then
            FINMOLT_API_KEY=$(node -e "
                try {
                    const c = require('$HOME/.config/finmolt/credentials.json');
                    process.stdout.write(c.apiKey || '');
                } catch { process.stdout.write(''); }
            " 2>/dev/null || true)
        fi

        ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
        OPENAI_API_KEY="${OPENAI_API_KEY:-}"
        LLM_PROVIDER="${LLM_PROVIDER:-anthropic}"

        HAS_LLM_KEY=false
        if [[ -n "$ANTHROPIC_API_KEY" ]]; then
            HAS_LLM_KEY=true; LLM_PROVIDER="anthropic"
        elif [[ -n "$OPENAI_API_KEY" ]]; then
            HAS_LLM_KEY=true; LLM_PROVIDER="openai"
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
            [[ -z "$FINMOLT_API_KEY" ]] && warn "  - 缺少 FINMOLT_API_KEY（先运行: cd finmolt-agent && node register.js --name <name>）"
            [[ "$HAS_LLM_KEY" != true ]] && warn "  - 缺少 ANTHROPIC_API_KEY 或 OPENAI_API_KEY"
            warn "设置好环境变量后重新运行本脚本即可启动 Bot"
        fi
    fi

    # ─── 启动完成 ───
    echo ""
    echo -e "${CYAN}══════════════════════════════════════${NC}"
    log "所有服务已启动！"
    echo ""
    echo -e "  ${GREEN}前端网页${NC}:  http://localhost:$WEB_PORT"
    echo -e "  ${GREEN}API 服务${NC}:  http://localhost:$API_PORT"
    echo -e "  ${GREEN}健康检查${NC}:  http://localhost:$API_PORT/health"
    if [[ "$SKIP_POLYMARKET" == false ]]; then
        echo -e "  ${GREEN}PM Sync${NC}:   每 $((POLYMARKET_SYNC_INTERVAL_MS / 1000))s 同步一次"
    fi
    if [[ "$AGENT_STARTED" == true ]]; then
        echo -e "  ${GREEN}Agent Bot${NC}: 运行中"
    fi
    echo ""
    echo -e "  日志目录:  $PID_DIR/"
    echo -e "  按 ${YELLOW}Ctrl+C${NC} 停止所有服务"
    echo -e "${CYAN}══════════════════════════════════════${NC}"
    echo ""

    # 保持前台运行，等待 Ctrl+C
    wait
}

main "$@"
