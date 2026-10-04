#!/usr/bin/env bash
set -euo pipefail

IMAGE='ghcr.io/agentshouse/kit@sha256:__IMAGE_DIGEST__'
VERSION='__KIT_VERSION__'
NAME='house-kit'
HOUSE='https://agents.house'
WORKSPACE="$HOME/AgentsHouse"
KIT_HOME="$HOME/.house-kit"
LINK='Open this link and confirm: '
RECONNECT='run this command again with kit login appended'
MANUAL=0
WORKSPACE_SELECTED=0
HOUSE_SELECTED=0
ENROLL=''
ENROLL_SELECTED=0
FORWARDING=0
FORWARDED=kit
FORWARD=()
NO_SKILLS=()
CONFIGURED=''
UBUNTU_RELEASES=(jammy noble resolute)
DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)
CONFLICTING_PACKAGES=(docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc)
DOCKER_APP=/Applications/Docker.app
DESKTOP_WAIT_SECONDS=300
RUNTIME='Docker Engine'
OPENER=xdg-open
NETWORK=(--network host)
NAMED=()
PUBLISHED=()
NATIVE=0
NATIVE_RELEASE=26.04
NATIVE_ARCHITECTURE=amd64
NATIVE_PACKAGES=(ca-certificates curl git)
NODE_VERSION=24.21.0
NODE_SHA256=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
NATIVE_PREFIX=/opt/house-kit
NATIVE_PACKAGE=/opt/house-kit/lib/node_modules/@agentshouse/kit/dist
IMAGE_PACKAGE=/usr/local/lib/node_modules/@agentshouse/kit/dist
DIRECT=(env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy)
NATIVE_BIN=/usr/local/bin
NATIVE_SERVICE=house-kit.service
NATIVE_UNIT=/etc/systemd/system/house-kit.service
NATIVE_WORKSPACE=/agents/house
RELEASE="@agentshouse/kit@$VERSION node@$NODE_VERSION"

refuse() {
  printf 'kit_bootstrap_refused: %s\n' "$1" >&2
  exit 1
}

bind_mount() {
  local source=${1//\"/\"\"}
  printf 'type=bind,"src=%s",dst=%s' "$source" "$2"
}

enrolled() {
  sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$KIT_HOME/credential.json"
}

login_kit() {
  if [[ " $* " == *' --manual '* ]]; then
    "${LOGIN_TYPED[@]}" "$@"
  else
    command -v "$OPENER" >/dev/null || refuse 'no host browser opener; rerun with --manual'
    "${LOGIN_OPENED[@]}" "$@" | while IFS= read -r line; do
      if [[ "$line" == "$LINK"* ]]; then
        printf 'Opening House Login in the host browser: %s\n' "${line#"$LINK"}"
        "$OPENER" "${line#"$LINK"}" >/dev/null 2>&1 || refuse 'host browser did not open; rerun with --manual'
      else
        printf '%s\n' "$line"
      fi
    done
  fi
  [[ -f "$KIT_HOME/credential.json" ]] || refuse 'kit login connected no Environment'
}

login_arguments() {
  LOGIN=()
  if ((HOUSE_SELECTED)); then LOGIN+=(--house "$HOUSE"); fi
  if ((MANUAL)); then LOGIN+=(--manual); fi
}

prepare_directory() {
  [[ ! -L "$1" ]] || refuse "$1 is a symbolic link"
  mkdir -p -m 700 "$1" || refuse "$1 could not be created"
  [[ -d "$1" ]] || refuse "$1 is not a directory"
  [[ -O "$1" ]] || refuse "$1 is not owned by this User"
  chmod 700 "$1" || refuse "$1 could not be owner-protected"
}

bind_house() {
  if [[ -f "$KIT_HOME/credential.json" ]]; then
    BOUND_HOUSE=$(enrolled house) || refuse 'the stored credential is unreadable'
    [[ -n "$BOUND_HOUSE" ]] || refuse 'the stored credential names no House origin'
    if ((HOUSE_SELECTED)) && [[ "$HOUSE" != "$BOUND_HOUSE" ]]; then
      refuse 'this Environment is bound to another House origin'
    fi
    HOUSE="$BOUND_HOUSE"
  fi
  [[ "$HOUSE" == https://* || "$HOUSE" == http://127.0.0.1:* || "$HOUSE" == http://localhost:* ]] || refuse 'House origin must use HTTPS or local loopback HTTP'
}

check_authority() {
  HOUSE_KIT_HOME="$KIT_HOME" "$@" ||
    refuse "House refuses the stored Kit credential of Environment $(enrolled environment); to reconnect it, $RECONNECT"
}

configure_kit() {
  CONFIGURED=$(HOUSE_KIT_HOME="$KIT_HOME" "$@" ${NO_SKILLS[@]+"${NO_SKILLS[@]}"}) || refuse 'the Kit configuration could not be written'
}

elevated() {
  if ((EUID == 0)); then
    "$@"
  else
    sudo "$@"
  fi
}

docker_member() {
  [[ " $(id -nG "$@") " == *' docker '* ]]
}

docker_answers() {
  DOCKER_PLATFORM=$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null)
}

docker_cause() {
  docker info 2>&1 >/dev/null | tail -n 1
}

unanswered() {
  type -P docker >/dev/null || return 0
  printf '; Docker Engine does not answer: %s' "$(docker_cause)"
}

install_docker_desktop() {
  local mount
  DOWNLOAD=$(mktemp -d) || refuse 'no temporary directory for the Docker Desktop download'
  trap 'rm -rf "$DOWNLOAD"' EXIT
  mount="$DOWNLOAD/volume"
  printf 'Downloading Docker Desktop for %s from docker.com.\n' "$1"
  curl -fsSL -o "$DOWNLOAD/Docker.dmg" "https://desktop.docker.com/mac/main/$ARCH/Docker.dmg" || refuse 'Docker Desktop could not be downloaded'
  printf 'Installing Docker Desktop in /Applications; sudo may ask for your password.\n'
  mkdir "$mount" || refuse 'the Docker Desktop disk image has no mount point'
  elevated hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$DOWNLOAD/Docker.dmg" >/dev/null || refuse 'the Docker Desktop disk image could not be opened'
  if ! elevated "$mount/Docker.app/Contents/MacOS/install" "--user=$(id -un)"; then
    elevated hdiutil detach "$mount" >/dev/null 2>&1 || true
    refuse 'the Docker Desktop installer did not finish'
  fi
  elevated hdiutil detach "$mount" >/dev/null || refuse 'the Docker Desktop disk image could not be closed'
}

establish_docker_desktop() {
  PATH="$PATH:$DOCKER_APP/Contents/Resources/bin"
  docker_answers && return
  if ((FORWARDING)); then
    [[ -d "$DOCKER_APP" ]] || refuse 'House Kit is not installed; run this bootstrap without arguments first'
    refuse "Docker Desktop does not answer: $(docker_cause); start Docker Desktop, then rerun this command"
  fi
  [[ -d "$DOCKER_APP" ]] || install_docker_desktop "$1"
  printf 'Starting Docker Desktop; accept its terms or finish its setup if its window asks.\n'
  open "$DOCKER_APP" || refuse 'Docker Desktop could not be opened'
  local waited=0
  until docker_answers; do
    ((waited < DESKTOP_WAIT_SECONDS)) || refuse "Docker Desktop is not ready: $(docker_cause); finish what its window asks, then rerun this bootstrap"
    sleep 2
    waited=$((waited + 2))
  done
}

installed_packages() {
  { dpkg-query -W -f='${db:Status-Status} ${Package}\n' "$@" 2>/dev/null || true; } | awk '$1 == "installed" { print $2 }'
}

install_docker_engine() {
  printf 'Installing Docker Engine from Docker'\''s apt repository for %s; sudo may ask for your password.\n' "$1"
  elevated apt-get update -qq >/dev/null || refuse 'apt could not refresh its package lists'
  elevated apt-get install -y -qq ca-certificates curl >/dev/null || refuse 'apt could not install ca-certificates and curl'
  elevated install -m 0755 -d /etc/apt/keyrings || refuse '/etc/apt/keyrings could not be created'
  elevated curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc || refuse 'the Docker apt repository key could not be downloaded'
  elevated chmod a+r /etc/apt/keyrings/docker.asc || refuse 'the Docker apt repository key could not be made readable'
  printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$2" "$(dpkg --print-architecture)" \
    | elevated tee /etc/apt/sources.list.d/docker.sources >/dev/null || refuse 'the Docker apt repository could not be configured'
  elevated apt-get update -qq >/dev/null || refuse 'apt could not read the Docker apt repository'
  elevated apt-get install -y -qq "${DOCKER_PACKAGES[@]}" >/dev/null || refuse 'apt could not install Docker Engine'
}

establish_docker_engine() {
  docker_answers && return
  if ((EUID != 0)) && ! docker_member && docker_member "$(id -un)"; then
    refuse "$(id -un) joined the docker group after this session began; sign out and back in, then rerun this bootstrap"
  fi
  local distribution='' release='' described='this Linux distribution' conflicting present
  if [[ -r /etc/os-release ]]; then
    distribution=$(. /etc/os-release && printf '%s' "${ID:-}")
    release=$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
    described=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-$described}")
  fi
  if ((FORWARDING)); then
    type -P docker >/dev/null || refuse 'House Kit is not installed; run this bootstrap without arguments first'
    refuse "Docker Engine does not answer: $(docker_cause)"
  fi
  if [[ "$distribution" != ubuntu ]]; then
    type -P docker >/dev/null || refuse "Docker Engine is not installed on $described; install a working Docker Engine, then rerun this bootstrap"
    refuse "Docker Engine does not answer on $described: $(docker_cause)"
  fi
  [[ " ${UBUNTU_RELEASES[*]} " == *" $release "* ]] || refuse "this bootstrap installs Docker Engine only on Ubuntu 22.04, 24.04 and 26.04 LTS, not $described; install a working Docker Engine, then rerun this bootstrap$(unanswered)"
  conflicting=$(installed_packages "${CONFLICTING_PACKAGES[@]}" | paste -sd ' ' -)
  [[ -z "$conflicting" ]] || refuse "the installed packages $conflicting conflict with Docker Engine; remove them or make their Docker Engine work, then rerun this bootstrap$(unanswered)"
  present=$(installed_packages "${DOCKER_PACKAGES[@]}" | wc -l)
  ((present == ${#DOCKER_PACKAGES[@]})) || install_docker_engine "$described" "$release"
  if ! systemctl is-active --quiet docker.service; then
    printf 'Starting Docker Engine; sudo may ask for your password.\n'
    elevated systemctl start docker.service || refuse 'Docker Engine could not be started'
  fi
  if ((EUID != 0)); then
    if ! docker_member "$(id -un)"; then
      printf 'Adding %s to the docker group; it applies from your next sign-in, so this run reaches Docker Engine through sudo.\n' "$(id -un)"
      elevated usermod -aG docker "$(id -un)" || refuse "$(id -un) could not be added to the docker group"
    fi
    docker_member || docker() { sudo -u "$(id -un)" docker "$@"; }
  fi
  docker_answers || refuse "Docker Engine does not answer: $(docker_cause)"
}

check_native_host() {
  local distribution='' release='' described=Linux
  if [[ -r /etc/os-release ]]; then
    distribution=$(. /etc/os-release && printf '%s' "${ID:-}")
    release=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
    described=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-$described}")
  fi
  [[ "$distribution" == ubuntu && "$release" == "$NATIVE_RELEASE" && "$ARCH" == "$NATIVE_ARCHITECTURE" ]] ||
    refuse "--linux runs only on Ubuntu $NATIVE_RELEASE LTS on $NATIVE_ARCHITECTURE, not $described on $ARCH"
}

service_manager() {
  [[ -d /run/systemd/system ]]
}

establish_native_packages() {
  local present
  present=$(installed_packages "${NATIVE_PACKAGES[@]}" | wc -l)
  ((present == ${#NATIVE_PACKAGES[@]})) && return
  printf 'Installing ca-certificates, curl and git from Ubuntu'\''s apt repository; sudo may ask for your password.\n'
  elevated "${DIRECT[@]}" apt-get update -qq >/dev/null || refuse 'apt could not refresh its package lists'
  elevated "${DIRECT[@]}" DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${NATIVE_PACKAGES[@]}" >/dev/null || refuse 'apt could not install ca-certificates, curl and git'
}

stage_native_kit() {
  umask 022
  NATIVE_STAGE=$(mktemp -d) || refuse 'no temporary directory for the Kit package'
  trap 'rm -rf "$NATIVE_STAGE"' EXIT
  printf 'Downloading Node.js %s from nodejs.org and House Kit %s from npm.\n' "$NODE_VERSION" "$VERSION"
  "${DIRECT[@]}" curl -fsSL -o "$NATIVE_STAGE/node.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz" || refuse 'Node.js could not be downloaded'
  printf '%s  %s\n' "$NODE_SHA256" "$NATIVE_STAGE/node.tar.gz" | sha256sum --check --quiet >/dev/null 2>&1 || refuse 'the Node.js download does not match its pinned checksum'
  mkdir "$NATIVE_STAGE/kit"
  tar -xzf "$NATIVE_STAGE/node.tar.gz" -C "$NATIVE_STAGE/kit" --strip-components=1 --no-same-owner || refuse 'Node.js could not be unpacked'
  "${DIRECT[@]}" PATH="$NATIVE_STAGE/kit/bin:$PATH" npm install --global --prefix "$NATIVE_STAGE/kit" --cache "$NATIVE_STAGE/cache" \
    --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error "@agentshouse/kit@$VERSION" >/dev/null || refuse "House Kit $VERSION could not be installed from npm"
  printf '%s\n' "$RELEASE" > "$NATIVE_STAGE/kit/release"
  chmod 0755 "$NATIVE_STAGE/kit"
}

place_native_kit() {
  local command
  printf 'Installing House Kit in %s; sudo may ask for your password.\n' "$NATIVE_PREFIX"
  elevated rm -rf "$NATIVE_PREFIX.new" "$NATIVE_PREFIX.old" && elevated mv "$NATIVE_STAGE/kit" "$NATIVE_PREFIX.new" &&
    elevated chown -R root:root "$NATIVE_PREFIX.new" || refuse "House Kit could not be installed in $NATIVE_PREFIX"
  if [[ -e "$NATIVE_PREFIX" ]]; then
    elevated mv "$NATIVE_PREFIX" "$NATIVE_PREFIX.old" || refuse "House Kit could not be installed in $NATIVE_PREFIX"
  fi
  if ! elevated mv "$NATIVE_PREFIX.new" "$NATIVE_PREFIX"; then
    [[ ! -e "$NATIVE_PREFIX.old" ]] || elevated mv "$NATIVE_PREFIX.old" "$NATIVE_PREFIX"
    refuse "House Kit could not be installed in $NATIVE_PREFIX"
  fi
  elevated rm -rf "$NATIVE_PREFIX.old"
  for command in kit house; do
    printf '#!/bin/sh\nPATH="%s/bin:$PATH" exec "%s/bin/%s" "$@"\n' "$NATIVE_PREFIX" "$NATIVE_PREFIX" "$command" |
      elevated tee "$NATIVE_BIN/$command" >/dev/null && elevated chmod 0755 "$NATIVE_BIN/$command" ||
      refuse "$NATIVE_BIN/$command could not be written"
  done
}

enroll_kit() {
  local credential=''
  IFS= read -rs -p 'Kit credential: ' credential || true
  if [[ -t 0 ]]; then printf '\n' >&2; fi
  [[ -n "$credential" ]] || refuse 'no Kit credential on standard input'
  printf '%s' "$credential" | HOUSE_KIT_HOME="$KIT_HOME" "$NATIVE_PREFIX/bin/node" "$NATIVE_PACKAGE/enrol-main.js" "$HOUSE" "$ENROLL" ||
    refuse 'the Kit credential could not be stored'
}

start_native_service() {
  printf '[Unit]\nDescription=House Kit\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nUser=%s\nWorkingDirectory=%s\nExecStart=%s/kit resident\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n' \
    "$(id -un)" "$NATIVE_WORKSPACE" "$NATIVE_BIN" | elevated tee "$NATIVE_UNIT" >/dev/null &&
    elevated chmod 0644 "$NATIVE_UNIT" || refuse "$NATIVE_UNIT could not be written"
  elevated systemctl daemon-reload || refuse 'systemd could not read the House Kit service'
  elevated systemctl --quiet enable --now "$NATIVE_SERVICE" || refuse 'the House Kit service could not be started'
}

connect_native() {
  local connected=updated
  RECONNECT="run $NATIVE_BIN/kit login"
  check_native_host
  if type -P docker >/dev/null && docker container inspect "$NAME" >/dev/null 2>&1; then
    refuse "House Kit runs in the container $NAME on this computer; remove that container, then rerun this bootstrap with --linux"
  fi
  if service_manager && [[ -f "$NATIVE_UNIT" ]] && ! grep -qx "User=$(id -un)" "$NATIVE_UNIT"; then
    refuse 'House Kit runs natively on this host for another account'
  fi
  establish_native_packages
  [[ ! -L "${NATIVE_WORKSPACE%/*}" ]] || refuse "${NATIVE_WORKSPACE%/*} is a symbolic link"
  if [[ ! -e "$NATIVE_WORKSPACE" && ! -L "$NATIVE_WORKSPACE" ]]; then
    printf 'Creating %s for the Agents on this host; sudo may ask for your password.\n' "$NATIVE_WORKSPACE"
    { [[ -d "${NATIVE_WORKSPACE%/*}" ]] || elevated install -d -m 0755 "${NATIVE_WORKSPACE%/*}"; } &&
      elevated install -d -m 0700 -o "$(id -u)" -g "$(id -g)" "$NATIVE_WORKSPACE" || refuse "$NATIVE_WORKSPACE could not be created"
  fi
  prepare_directory "$KIT_HOME"
  KIT_HOME=$(cd "$KIT_HOME" && pwd -P)
  bind_house
  if ((ENROLL_SELECTED)) && [[ -f "$KIT_HOME/credential.json" && "$(enrolled environment)" != "$ENROLL" ]]; then
    refuse "this host is enrolled for Environment $(enrolled environment), not $ENROLL"
  fi
  if [[ "$(cat "$NATIVE_PREFIX/release" 2>/dev/null || true)" != "$RELEASE" ]]; then
    stage_native_kit
    if service_manager && systemctl is-active --quiet "$NATIVE_SERVICE"; then
      elevated systemctl stop "$NATIVE_SERVICE" || refuse 'the House Kit service could not be stopped'
    fi
    place_native_kit
  elif service_manager && systemctl is-active --quiet "$NATIVE_SERVICE"; then
    connected=running
  else
    connected=restarted
  fi
  if [[ -f "$KIT_HOME/credential.json" ]]; then
    check_authority "$NATIVE_PREFIX/bin/node" "$NATIVE_PACKAGE/authority-main.js"
  elif ((ENROLL_SELECTED)); then
    connected=connected
    enroll_kit
    check_authority "$NATIVE_PREFIX/bin/node" "$NATIVE_PACKAGE/authority-main.js"
  else
    connected=connected
    LOGIN_TYPED=(env "HOUSE_KIT_HOME=$KIT_HOME" "$NATIVE_BIN/kit" login)
    LOGIN_OPENED=("${LOGIN_TYPED[@]}")
    login_arguments
    login_kit ${LOGIN[@]+"${LOGIN[@]}"}
  fi
  configure_kit "$NATIVE_PREFIX/bin/node" "$NATIVE_PACKAGE/configure-main.js"
  if ! service_manager; then
    printf 'House Kit %s is installed for Environment %s; no service manager runs on this host, so start it with: %s/kit resident\n' \
      "$VERSION" "$(enrolled environment)" "$NATIVE_BIN"
    return
  fi
  start_native_service
  if [[ "$connected" == running && -n "$CONFIGURED" ]]; then
    elevated systemctl restart "$NATIVE_SERVICE" || refuse 'the House Kit service could not be restarted'
    connected=restarted
  fi
  case "$connected" in
    connected) printf 'House Kit connected for Environment %s.\n' "$(enrolled environment)" ;;
    updated) printf 'House Kit updated for Environment %s.\n' "$(enrolled environment)" ;;
    running) printf 'House Kit is already running for Environment %s.\n' "$(enrolled environment)" ;;
    restarted) printf 'House Kit restarted for Environment %s.\n' "$(enrolled environment)" ;;
  esac
}

kit_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$NAME")" == true ]]
}

kit_installed() {
  docker container inspect "$NAME" >/dev/null 2>&1
}

check_installation() {
  [[ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$NAME")" == unless-stopped ]] || refuse 'the installed Kit has a different lifecycle'
  [[ "$(docker inspect --format '{{len .Mounts}}' "$NAME")" == 2 ]] || refuse 'the installed Kit has unexpected mounts'
  [[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/kit-home"}}{{.Source}}{{end}}{{end}}' "$NAME")" == "$KIT_HOME" ]] || refuse 'the installed Kit uses another Kit home'
  [[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/kit-home"}}{{.Type}}/{{.RW}}{{end}}{{end}}' "$NAME")" == bind/true ]] || refuse 'the installed Kit home is not a writable bind mount'
  [[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/agents/house"}}{{.Source}}{{end}}{{end}}' "$NAME")" == "$WORKSPACE" ]] || refuse 'the installed Kit uses another workspace root'
  [[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/agents/house"}}{{.Type}}/{{.RW}}{{end}}{{end}}' "$NAME")" == bind/true ]] || refuse 'the installed workspace is not a writable bind mount'
  [[ "$(docker inspect --format '{{index .Config.Labels "agentshouse.house"}}' "$NAME")" == "$HOUSE" ]] || refuse 'the installed Kit uses another House origin'
}

forward_kit() {
  local placed=() entry=() terminal=() here
  if [[ "$FORWARDED" == house ]]; then
    here=$(pwd -P)
    [[ "$here" == "$WORKSPACE" || "$here" == "$WORKSPACE"/* ]] || refuse "the current directory is outside the workspace $WORKSPACE"
    placed=(--workdir "/agents/house${here#"$WORKSPACE"}")
    entry=(--entrypoint house)
  fi
  if [[ -t 0 && -t 1 ]]; then terminal=(-t); fi
  if [[ -t 0 && ! -t 1 ]]; then
    ECHOED=$(stty -g)
    trap 'stty "$ECHOED"' EXIT
    stty -echo
  fi
  if kit_running; then
    docker exec -i ${terminal[@]+"${terminal[@]}"} ${placed[@]+"${placed[@]}"} "$NAME" "$FORWARDED" ${FORWARD[@]+"${FORWARD[@]}"}
  else
    "${DOCKER_RUN[@]:0:2}" -i ${terminal[@]+"${terminal[@]}"} ${placed[@]+"${placed[@]}"} ${entry[@]+"${entry[@]}"} "${DOCKER_RUN[@]:2}" ${FORWARD[@]+"${FORWARD[@]}"}
  fi
}

start_resident() {
  local network=()
  [[ "$HOUSE" == https://* ]] || network=(--network host)
  docker run -d --name "$NAME" --restart unless-stopped ${network[@]+"${network[@]}"} --user "$(id -u):$(id -g)" --mount "$KIT_HOME_MOUNT" --mount "$WORKSPACE_MOUNT" --label "agentshouse.house=$HOUSE" "$IMAGE" resident >/dev/null
}

update_kit() {
  docker pull --quiet --platform "linux/$ARCH" "$IMAGE" >/dev/null
  docker rm -f "$NAME" >/dev/null
  start_resident
  printf 'House Kit updated for Environment %s.\n' "$(enrolled environment)"
}

resume_kit() {
  if ! kit_running; then
    docker start "$NAME" >/dev/null
  elif [[ -n "$CONFIGURED" ]]; then
    docker restart "$NAME" >/dev/null
  else
    printf 'House Kit is already running for Environment %s.\n' "$(enrolled environment)"
    return
  fi
  printf 'House Kit restarted for Environment %s.\n' "$(enrolled environment)"
}

connect_kit() {
  if [[ -f "$KIT_HOME/credential.json" ]]; then
    check_authority "${AUTHORITY[@]}"
  else
    login_arguments
    login_kit ${LOGIN[@]+"${LOGIN[@]}"}
  fi
  configure_kit "${CONFIGURE[@]}"
  start_resident
  printf 'House Kit connected for Environment %s.\n' "$(enrolled environment)"
}

while (($#)); do
  case "$1" in
    kit|house)
      FORWARDING=1
      FORWARDED="$1"
      FORWARD=("${@:2}")
      break
      ;;
    --workspace|--house|--enroll)
      (($# >= 2)) || refuse "$1 requires one value"
      case "$1" in
        --workspace)
          ((WORKSPACE_SELECTED == 0)) || refuse 'supply exactly one workspace root'
          WORKSPACE="$2"
          WORKSPACE_SELECTED=1
          ;;
        --house)
          ((HOUSE_SELECTED == 0)) || refuse 'supply exactly one House origin'
          HOUSE="$2"
          HOUSE_SELECTED=1
          ;;
        --enroll)
          ((ENROLL_SELECTED == 0)) || refuse 'supply exactly one Environment to enroll'
          ENROLL="$2"
          ENROLL_SELECTED=1
          ;;
      esac
      shift 2
      ;;
    --manual)
      MANUAL=1
      shift
      ;;
    --linux)
      NATIVE=1
      shift
      ;;
    --no-skills)
      NO_SKILLS=(--no-skills)
      shift
      ;;
    *) refuse "unknown argument $1" ;;
  esac
done
((ENROLL_SELECTED == 0 || NATIVE)) || refuse '--enroll enrolls a server; add --linux'
((FORWARDING == 0 || NATIVE == 0)) || refuse "--linux puts kit and house on this host's PATH; run $FORWARDED there directly"
if ((NATIVE)); then
  ((WORKSPACE_SELECTED == 0)) || refuse "--linux keeps its workspace at $NATIVE_WORKSPACE; --workspace is for a container"
elif [[ -e "$NATIVE_PREFIX" ]]; then
  ((FORWARDING == 0)) || refuse "House Kit runs natively on this host; run $FORWARDED there directly"
  refuse 'House Kit runs natively on this host; rerun this bootstrap with --linux'
fi

[[ "$IMAGE" =~ ^ghcr\.io/agentshouse/kit@sha256:[0-9a-f]{64}$ && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] ||
  refuse 'this bootstrap has not been published with an immutable release'
case "$(uname -s)" in
  Linux)
    case "$(uname -m)" in
      x86_64|amd64) ARCH=amd64 ;;
      aarch64|arm64) ARCH=arm64 ;;
      *) refuse "unsupported Linux architecture $(uname -m)" ;;
    esac
    ;;
  Darwin)
    ((NATIVE == 0)) || refuse "--linux runs only on Ubuntu $NATIVE_RELEASE LTS on $NATIVE_ARCHITECTURE, not macOS"
    RUNTIME='Docker Desktop'
    OPENER=open
    if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" == 1 ]]; then
      ARCH=arm64
      CHIP='Apple silicon'
    else
      ARCH=amd64
      CHIP='an Intel chip'
    fi
    ;;
  *) refuse "unsupported host $(uname -s); this bootstrap is for Linux and macOS" ;;
esac

if ((NATIVE)); then
  connect_native
  exit 0
fi

[[ "$WORKSPACE" == /* ]] || refuse 'workspace root must be an absolute path'
if [[ "$RUNTIME" == 'Docker Desktop' ]]; then
  establish_docker_desktop "$CHIP"
  DOCKER_SYSTEM=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null) || refuse "Docker Desktop does not answer: $(docker_cause)"
  [[ "$DOCKER_SYSTEM" == 'Docker Desktop' ]] || refuse "Docker answers from $DOCKER_SYSTEM, not Docker Desktop; stop that engine or switch Docker to Docker Desktop, then rerun this bootstrap"
else
  establish_docker_engine
fi
case "$DOCKER_PLATFORM" in
  linux/x86_64|linux/amd64) DOCKER_ARCH=amd64 ;;
  linux/aarch64|linux/arm64) DOCKER_ARCH=arm64 ;;
  *) refuse "unsupported $RUNTIME platform $DOCKER_PLATFORM" ;;
esac
[[ "$DOCKER_ARCH" == "$ARCH" ]] || refuse "host linux/$ARCH does not match $RUNTIME linux/$DOCKER_ARCH"
if ((FORWARDING)); then
  kit_installed || refuse 'House Kit is not installed; run this bootstrap without arguments first'
  WORKSPACE=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/agents/house"}}{{.Source}}{{end}}{{end}}' "$NAME")
fi

umask 077
for path in "$KIT_HOME" "$WORKSPACE"; do
  prepare_directory "$path"
done
KIT_HOME=$(cd "$KIT_HOME" && pwd -P)
WORKSPACE=$(cd "$WORKSPACE" && pwd -P)
[[ "$WORKSPACE/" != "$KIT_HOME/"* && "$KIT_HOME/" != "$WORKSPACE/"* ]] || refuse "the workspace root $WORKSPACE and Kit home $KIT_HOME must not contain each other"
KIT_HOME_MOUNT=$(bind_mount "$KIT_HOME" /kit-home)
WORKSPACE_MOUNT=$(bind_mount "$WORKSPACE" /agents/house)
bind_house

if [[ "$RUNTIME" == 'Docker Desktop' ]]; then NAMED=(--hostname "$(hostname)"); fi
if [[ "$RUNTIME" == 'Docker Desktop' && "$HOUSE" == https://* ]]; then
  NETWORK=()
  LOGIN_PORT=$((49152 + RANDOM % 16384))
  PUBLISHED=(--publish "127.0.0.1:$LOGIN_PORT:$LOGIN_PORT" --env "HOUSE_KIT_LOGIN_PORT=$LOGIN_PORT")
fi
DOCKER_RUN=(docker run --rm ${NETWORK[@]+"${NETWORK[@]}"} ${NAMED[@]+"${NAMED[@]}"} --user "$(id -u):$(id -g)" --mount "$KIT_HOME_MOUNT" --mount "$WORKSPACE_MOUNT" "$IMAGE")
LOGIN_TYPED=("${DOCKER_RUN[@]:0:2}" -i "${DOCKER_RUN[@]:2}" login)
LOGIN_OPENED=("${DOCKER_RUN[@]:0:2}" ${PUBLISHED[@]+"${PUBLISHED[@]}"} "${DOCKER_RUN[@]:2}" login)
AUTHORITY=("${DOCKER_RUN[@]:0:2}" --entrypoint node "${DOCKER_RUN[@]:2}" "$IMAGE_PACKAGE/authority-main.js")
CONFIGURE=("${DOCKER_RUN[@]:0:2}" --entrypoint node "${DOCKER_RUN[@]:2}" "$IMAGE_PACKAGE/configure-main.js")

if kit_installed; then
  check_installation
  [[ -f "$KIT_HOME/credential.json" ]] || refuse 'the installed Kit has no enrolled authority'
  if ((FORWARDING)); then
    [[ "$(docker inspect --format '{{.Config.Image}}' "$NAME")" == "$IMAGE" ]] || refuse 'an installed Kit uses a different image; rerun this bootstrap without arguments to update it'
    if [[ "$FORWARDED" == kit && "${FORWARD[0]:-}" == login ]]; then
      login_kit ${FORWARD[@]+"${FORWARD[@]:1}"}
      exit 0
    fi
    forward_kit
    exit
  fi
  check_authority "${AUTHORITY[@]}"
  configure_kit "${CONFIGURE[@]}"
  if [[ "$(docker inspect --format '{{.Config.Image}}' "$NAME")" != "$IMAGE" ]]; then
    update_kit
  else
    resume_kit
  fi
  exit 0
fi

docker pull --quiet --platform "linux/$ARCH" "$IMAGE" >/dev/null
connect_kit
