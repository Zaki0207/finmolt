#!/usr/bin/env bash
# 停止所有 FinMolt 服务
PID_DIR="$(cd "$(dirname "$0")" && pwd)/.pids"

# 停止 start.sh 管理的进程
if [[ -d "$PID_DIR" ]]; then
    for f in "$PID_DIR"/*.pid; do
        [[ -f "$f" ]] || continue
        pid=$(cat "$f")
        if kill -0 "$pid" 2>/dev/null; then
            pkill -TERM -P "$pid" 2>/dev/null
            kill -TERM "$pid" 2>/dev/null
            echo "Stopped $(basename "$f" .pid) (PID $pid)"
        fi
    done
    rm -rf "$PID_DIR"
fi

# 杀掉端口上残留的进程
for port in 3001 3000; do
    pids=$(lsof -ti:"$port" 2>/dev/null)
    if [[ -n "$pids" ]]; then
        echo "$pids" | xargs kill -9 2>/dev/null
        echo "Killed port $port"
    fi
done

# 杀掉 bot.js 进程
pkill -f "node bot.js" 2>/dev/null && echo "Killed agent bot"

echo "Done."
