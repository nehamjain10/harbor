#!/bin/sh
# Builds this checkout's frontend and publishes it to the preview site, a second page on
# its own port that talks to the live server (scripts/preview-server.mjs).
# The page picks the new build up on reload; the preview server restarts only when its
# own code changed. Usage: scripts/preview.sh
#
# Settings come from the environment or from local.env (this checkout's, else the live
# install's): WORKBENCH_OWNER, PREVIEW_ORIGIN and LIVE_ORIGIN (https://<host>:<port> of
# the preview and the live site), optionally PREVIEW_DIR, PREVIEW_LOG and LIVE_DIR.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
live="${LIVE_DIR:-$HOME/.local/share/claude-workbench}"
for env_file in "$repo/local.env" "$live/local.env"; do
  if [ -f "$env_file" ]; then
    set -a
    . "$env_file"
    set +a
    break
  fi
done
: "${WORKBENCH_OWNER:?set WORKBENCH_OWNER}"
: "${PREVIEW_ORIGIN:?set PREVIEW_ORIGIN}"
: "${LIVE_ORIGIN:?set LIVE_ORIGIN}"
dest="${PREVIEW_DIR:-$HOME/.local/share/harbor-preview}"
log="${PREVIEW_LOG:-$dest/preview.log}"
node "$repo/scripts/build.mjs"
mkdir -p "$dest"
chmod 700 "$dest"
rm -rf "$dest/public.new"
cp -a "$repo/public" "$dest/public.new"
[ -d "$dest/public" ] && mv "$dest/public" "$dest/public.old"
mv "$dest/public.new" "$dest/public"
rm -rf "$dest/public.old"
ln -sfn "$live/node_modules" "$dest/node_modules"
changed=0
for file in server/static.mjs scripts/preview-server.mjs; do
  name=$(basename "$file")
  if ! cmp -s "$repo/$file" "$dest/$name"; then
    cp "$repo/$file" "$dest/$name"
    changed=1
  fi
done
printf '{"type":"module"}\n' > "$dest/package.json"
cat > "$dest/run.sh" <<RUN
#!/bin/sh
export WORKBENCH_OWNER=$WORKBENCH_OWNER
export PREVIEW_ORIGIN=$PREVIEW_ORIGIN
export LIVE_ORIGIN=$LIVE_ORIGIN
export LIVE_SOCKET=$live/web.sock
export PREVIEW_DIR=$dest
cd "$dest"
while true; do
  node preview-server.mjs
  sleep 3
done
RUN
chmod 755 "$dest/run.sh"
if ! pgrep -f "^/bin/sh $dest/run.sh" >/dev/null; then
  setsid nohup "$dest/run.sh" >> "$log" 2>&1 < /dev/null &
  echo "preview server started"
elif [ "$changed" = 1 ]; then
  pid=$(pgrep -f "^node preview-server.mjs" | while read -r p; do [ "$(readlink /proc/$p/cwd)" = "$dest" ] && echo "$p"; done | head -1)
  [ -n "$pid" ] && kill "$pid" && echo "preview server restarted (pid $pid)"
fi
echo "published $(git -C "$repo" rev-parse --short HEAD)$(git -C "$repo" diff --quiet || echo '+changes') to $dest"
