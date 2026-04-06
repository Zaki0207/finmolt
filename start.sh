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
    kill_service "$PID_DIR/settle.pid"     "Settlement Worker"
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

        # 初次同步完成后运行数据完整性校验（validate_sync 也在每次 polymarket sync 结束时自动调用）
        step "数据完整性校验"
        SYNC_HEALTH_FILE="${SYNC_HEALTH_FILE:-/tmp/finmolt-sync-health.json}"
        if (cd "$API_DIR" && SYNC_HEALTH_FILE="$SYNC_HEALTH_FILE" node scripts/validate_sync.js); then
            log "数据校验完成 ✓  报告: $SYNC_HEALTH_FILE"
        else
            warn "数据校验异常，请查看 $SYNC_HEALTH_FILE"
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
            SYNC_STATUS_FILE="$PID_DIR/polymarket_status.json" \
            node scripts/sync_polymarket.js --watch > "$PID_DIR/polymarket.log" 2>&1) &
        echo $! > "$PID_DIR/polymarket.pid"

        PRICES_SYNC_INTERVAL_MS="${PRICES_SYNC_INTERVAL_MS:-120000}"
        log "启动 CLOB 价格同步 (每 $((PRICES_SYNC_INTERVAL_MS / 1000))s)..."
        (cd "$API_DIR" && PRICES_SYNC_INTERVAL_MS="$PRICES_SYNC_INTERVAL_MS" \
            SYNC_STATUS_FILE="$PID_DIR/prices_status.json" \
            node scripts/sync_prices.js --watch > "$PID_DIR/prices.log" 2>&1) &
        echo $! > "$PID_DIR/prices.pid"

        SETTLE_INTERVAL_MS="${SETTLE_INTERVAL_MS:-300000}"
        log "启动结算 Worker (每 $((SETTLE_INTERVAL_MS / 1000))s)..."
        (cd "$API_DIR" && SETTLE_INTERVAL_MS="$SETTLE_INTERVAL_MS" \
            node scripts/settle_worker.js --watch > "$PID_DIR/settle.log" 2>&1) &
        echo $! > "$PID_DIR/settle.pid"

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
        echo -e "  ${GREEN}市场同步${NC}  每 $((POLYMARKET_SYNC_INTERVAL_MS / 1000))s (含自动数据校验)"
        echo -e "  ${GREEN}价格同步${NC}  每 $((PRICES_SYNC_INTERVAL_MS / 1000))s (CLOB)"
        echo -e "  ${GREEN}结算 Worker${NC} 每 $((SETTLE_INTERVAL_MS / 1000))s (独立结算进程)"
        echo -e "  ${GREEN}健康报告${NC}  ${SYNC_HEALTH_FILE:-/tmp/finmolt-sync-health.json}"
    fi
    [[ "$AGENT_STARTED" == true ]] && echo -e "  ${GREEN}Agent Bot${NC} 运行中"
    echo ""
    echo -e "  日志目录: $PID_DIR/"
    echo -e "  按 ${YELLOW}Ctrl+C${NC} 停止所有服务"
    echo -e "${CYAN}══════════════════════════════════════${NC}"
    echo ""

    # ─── 实时状态面板 ───
    if [[ "$SKIP_POLYMARKET" == false ]]; then
        status_dashboard
    else
        # 没有同步进程时直接 wait
        wait -n 2>/dev/null && warn "某个服务已退出，按 Ctrl+C 停止全部" && wait || wait
    fi
}

# ═══════════════════════════════════════════════════════
# 实时状态面板 — 每 5 秒刷新
# ═══════════════════════════════════════════════════════

format_countdown() {
    local secs=$1
    if [[ $secs -le 0 ]]; then
        echo "即将开始"
    elif [[ $secs -lt 60 ]]; then
        echo "${secs}s"
    else
        echo "$((secs / 60))m $((secs % 60))s"
    fi
}

format_time() {
    # ISO 8601 → local HH:MM:SS
    local iso=$1
    if [[ -z "$iso" || "$iso" == "null" ]]; then
        echo "--:--:--"
        return
    fi
    # macOS date vs GNU date
    if date -j -f "%Y-%m-%dT%H:%M:%S" "$(echo "$iso" | cut -c1-19)" "+%H:%M:%S" 2>/dev/null; then
        return
    fi
    date -d "$iso" "+%H:%M:%S" 2>/dev/null || echo "${iso:11:8}"
}

read_status_json() {
    local file=$1
    if [[ -f "$file" ]]; then
        cat "$file" 2>/dev/null
    else
        echo '{}'
    fi
}

json_val() {
    # Minimal JSON value extractor (no jq dependency)
    local json=$1 key=$2
    echo "$json" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^,\"}\n]*\)\"\{0,1\}.*/\1/p" | head -1
}

render_sync_line() {
    local label=$1 json=$2
    local status last_sync duration next_sync countdown_str
    status=$(json_val "$json" "status")
    last_sync=$(json_val "$json" "lastSync")
    duration=$(json_val "$json" "durationSec")
    next_sync=$(json_val "$json" "nextSync")

    local last_time
    last_time=$(format_time "$last_sync")

    # Calculate countdown to next sync
    local countdown=""
    if [[ -n "$next_sync" && "$next_sync" != "null" ]]; then
        local next_epoch now_epoch
        # macOS
        next_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$(echo "$next_sync" | cut -c1-19)" "+%s" 2>/dev/null)
        if [[ -z "$next_epoch" ]]; then
            # GNU/Linux
            next_epoch=$(date -d "$next_sync" "+%s" 2>/dev/null)
        fi
        now_epoch=$(date "+%s")
        if [[ -n "$next_epoch" ]]; then
            local diff=$(( next_epoch - now_epoch ))
            countdown=$(format_countdown "$diff")
        fi
    fi

    # Status icon
    local icon
    case "$status" in
        ok)      icon="${GREEN}✓${NC}" ;;
        syncing) icon="${YELLOW}⟳${NC}" ;;
        error)   icon="${RED}✗${NC}" ;;
        *)       icon="${YELLOW}…${NC}" ;;
    esac

    if [[ "$status" == "syncing" ]]; then
        printf "  %b %-18s ${YELLOW}同步中...${NC}\n" "$icon" "$label"
    elif [[ -n "$last_sync" && "$last_sync" != "null" ]]; then
        printf "  %b %-18s 上次: %s (%ss)" "$icon" "$label" "$last_time" "$duration"
        if [[ -n "$countdown" ]]; then
            printf "  下次: %s" "$countdown"
        fi
        echo ""
    else
        printf "  %b %-18s ${YELLOW}等待首次同步...${NC}\n" "$icon" "$label"
    fi
}

render_sync_detail() {
    local json=$1 type=$2
    local status
    status=$(json_val "$json" "status")

    if [[ "$type" == "polymarket" && "$status" == "ok" ]]; then
        local events markets settled
        events=$(json_val "$json" "events")
        markets=$(json_val "$json" "markets")
        settled=$(json_val "$json" "settled")
        printf "                       事件: %s  市场: %s" "${events:-0}" "${markets:-0}"
        [[ "${settled:-0}" != "0" ]] && printf "  结算: %s" "$settled"
        echo ""
    elif [[ "$type" == "prices" && "$status" == "ok" ]]; then
        local updated failed total
        updated=$(json_val "$json" "updated")
        failed=$(json_val "$json" "failed")
        total=$(json_val "$json" "totalMarkets")
        printf "                       更新: %s/%s" "${updated:-0}" "${total:-0}"
        [[ "${failed:-0}" != "0" ]] && printf "  ${RED}失败: %s${NC}" "$failed"
        echo ""
    elif [[ "$status" == "error" ]]; then
        local error_msg
        error_msg=$(json_val "$json" "error")
        printf "                       ${RED}错误: %s${NC}\n" "${error_msg:0:60}"
    fi
}

status_dashboard() {
    local REFRESH_SEC=5
    local prev_lines=0

    while true; do
        # Check if child processes are still alive
        local api_alive=false web_alive=false agent_alive=false settle_alive=false
        [[ -f "$PID_DIR/api.pid"    ]] && kill -0 "$(cat "$PID_DIR/api.pid")"    2>/dev/null && api_alive=true
        [[ -f "$PID_DIR/web.pid"    ]] && kill -0 "$(cat "$PID_DIR/web.pid")"    2>/dev/null && web_alive=true
        [[ -f "$PID_DIR/settle.pid" ]] && kill -0 "$(cat "$PID_DIR/settle.pid")" 2>/dev/null && settle_alive=true

        if [[ "$api_alive" == false && "$web_alive" == false ]]; then
            warn "所有核心服务已退出"
            break
        fi

        # Read status files
        local poly_json prices_json
        poly_json=$(read_status_json "$PID_DIR/polymarket_status.json")
        prices_json=$(read_status_json "$PID_DIR/prices_status.json")

        [[ -f "$PID_DIR/agent.pid" ]] && kill -0 "$(cat "$PID_DIR/agent.pid")" 2>/dev/null && agent_alive=true

        # Capture rendered content into a variable so we can count lines
        local content
        content=$(
            echo ""
            echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
            echo -e "${CYAN}║              FinMolt 服务运行状态                        ║${NC}"
            echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
            echo ""

            echo -e " ${CYAN}服务${NC}"
            if [[ "$api_alive" == true ]]; then
                echo -e "  ${GREEN}✓${NC} API               http://localhost:$API_PORT"
            else
                echo -e "  ${RED}✗${NC} API               ${RED}已停止${NC}"
            fi
            if [[ "$web_alive" == true ]]; then
                echo -e "  ${GREEN}✓${NC} Web               http://localhost:$WEB_PORT"
            else
                echo -e "  ${RED}✗${NC} Web               ${RED}已停止${NC}"
            fi
            if [[ "$agent_alive" == true ]]; then
                echo -e "  ${GREEN}✓${NC} Agent Bot         运行中"
            elif [[ "$SKIP_AGENT" == false && -d "$AGENT_DIR" ]]; then
                echo -e "  ${YELLOW}–${NC} Agent Bot         未启动"
            fi
            if [[ "$SKIP_POLYMARKET" == false ]]; then
                if [[ "$settle_alive" == true ]]; then
                    echo -e "  ${GREEN}✓${NC} Settlement Worker 运行中 (每 $((SETTLE_INTERVAL_MS / 1000))s)"
                else
                    echo -e "  ${RED}✗${NC} Settlement Worker ${RED}已停止${NC}"
                fi
            fi

            echo ""
            echo -e " ${CYAN}数据同步${NC}"
            render_sync_line "Polymarket 市场" "$poly_json"
            render_sync_detail "$poly_json" "polymarket"
            render_sync_line "CLOB 实时价格" "$prices_json"
            render_sync_detail "$prices_json" "prices"

            echo ""
            echo -e " ${CYAN}日志${NC}"
            echo "  API:        tail -f $PID_DIR/api.log"
            echo "  Polymarket: tail -f $PID_DIR/polymarket.log"
            echo "  Prices:     tail -f $PID_DIR/prices.log"
            echo "  Settle:     tail -f $PID_DIR/settle.log"

            echo ""
            echo -e "  刷新间隔: ${REFRESH_SEC}s | 按 ${YELLOW}Ctrl+C${NC} 停止所有服务"
            echo -e "${CYAN}──────────────────────────────────────────────────────────${NC}"
        )

        # Move cursor up to overwrite previous render (skip on first iteration)
        if [[ $prev_lines -gt 0 ]]; then
            printf "\033[%dA" "$prev_lines"
        fi

        # Print each line, clearing stale content first
        local line_count=0
        while IFS= read -r line; do
            printf "\033[2K%s\n" "$line"
            (( line_count++ ))
        done <<< "$content"

        # Clear any leftover lines from a previously taller render
        if [[ $prev_lines -gt $line_count ]]; then
            local extra=$(( prev_lines - line_count ))
            for (( i=0; i<extra; i++ )); do printf "\033[2K\n"; done
            printf "\033[%dA" "$extra"
        fi

        prev_lines=$line_count

        sleep $REFRESH_SEC
    done
}

main "$@"
