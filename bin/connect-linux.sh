#!/usr/bin/env bash
set -euo pipefail
export NODE_USE_SYSTEM_CA=1

VERSION='__KIT_RELEASE__'
KIT_SHA256='__KIT_SHA256__'
ADAPTERS='__ADAPTERS__'
HOUSE='https://agents.house'
HOUSE_SELECTED=0
KIT_HOME="$HOME/.agents/house"
CODE=()
PLACE=''
PLACING=0
MACOS=0
MACOS_RELEASE=27
NATIVE_RELEASE=26.04
CONTRACT_CHIP=amd64
CERTIFICATE_BUNDLES=(/etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem)
NODE_VERSION=24.22.1
NODE_MACOS=13.5
NODE_GLIBC=2.28
NODE_PLATFORM=linux-x64
NODE_SHA256=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c
NODE_BYTES=58290700
CHECKSUM=(sha256sum)
TRUST=()
DIRECT=(env)
[[ -z "${HOUSE_KIT_RELAY:-}" ]] || DIRECT=(env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy)

refuse() {
  printf 'kit_bootstrap_refused: %s\n' "$1" >&2
  exit 1
}

host_of() {
  local host=${1#*://}
  printf '%s' "${host%%/*}"
}

served_from() {
  if [[ -n "${HOUSE_KIT_RELAY:-}" ]]; then
    printf '%s/%s' "$HOUSE_KIT_RELAY" "$(host_of "$HOUSE")"
  else
    printf '%s' "$HOUSE"
  fi
}

download() {
  local most=${5:-} seconds
  if [[ -z "$most" ]]; then
    "${DIRECT[@]}" curl ${TRUST[@]+"${TRUST[@]}"} -fsSL -o "$4" "$(served_from)/kit-installer/$2" || refuse "$1 could not be downloaded from $HOUSE"
  else
    seconds=$(((most + 99999) / 100000))
    # A download with a pinned size arrives at a hundred kilobytes a second or ends, so a stalled Building cannot hold the install open.
    (trap '' XFSZ && ulimit -f $(((most + 1023) / 1024)) && exec "${DIRECT[@]}" curl ${TRUST[@]+"${TRUST[@]}"} -fsSL --max-time "$seconds" -o "$4" "$(served_from)/kit-installer/$2") || {
      local failed=$?
      (($(wc -c 2>/dev/null < "$4" || echo 0) < most)) || refuse "the $1 download is larger than its pinned $most bytes"
      ((failed != 28)) || refuse "the $1 download did not arrive within $seconds seconds"
      refuse "$1 could not be downloaded from $HOUSE"
    }
  fi
  printf '%s  %s\n' "$3" "$4" | "${CHECKSUM[@]}" --check >/dev/null 2>&1 || refuse "the $1 download does not match its pinned checksum"
}

elevated() {
  if ((EUID == 0)); then
    "$@"
  else
    sudo "$@"
  fi
}

at_least() {
  local major=${1%%.*} minor=${1#*.}
  minor=${minor%%.*}
  ((major > ${2%%.*} || (major == ${2%%.*} && minor >= ${2#*.})))
}

named() {
  printf '%s' "$1"
  shift
  while (($# > 1)); do
    printf ', %s' "$1"
    shift
  done
  (($# == 0)) || printf ' and %s' "$1"
}

absent_native_packages() {
  local bundle certified=0
  ABSENT=()
  for bundle in "${CERTIFICATE_BUNDLES[@]}"; do
    [[ ! -f "$bundle" ]] || certified=1
  done
  ((certified)) || ABSENT+=(ca-certificates)
  type -P curl >/dev/null || ABSENT+=(curl)
  type -P git >/dev/null || ABSENT+=(git)
}

establish_native_packages() {
  local absent
  absent_native_packages
  ((${#ABSENT[@]})) || return 0
  absent=$(named "${ABSENT[@]}")
  type -P apt-get >/dev/null || refuse "this host has no apt to install $absent; install $absent, then run this command again"
  printf 'Installing %s with apt; sudo may ask for your password.\n' "$absent"
  elevated "${DIRECT[@]}" apt-get update -qq >/dev/null || refuse 'apt could not refresh its package lists'
  elevated "${DIRECT[@]}" DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${ABSENT[@]}" >/dev/null || refuse "apt could not install $absent"
}

trust_extra_authorities() {
  local bundle
  TRUST=()
  [[ -s "${NODE_EXTRA_CA_CERTS:-}" ]] || return 0
  for bundle in "${CERTIFICATE_BUNDLES[@]}"; do
    [[ -f "$bundle" ]] || continue
    cat "$bundle" "$NODE_EXTRA_CA_CERTS" > "$1/authorities.pem" || refuse "$1/authorities.pem could not be written"
    TRUST=(--cacert "$1/authorities.pem")
    return 0
  done
}

place_release() {
  local prefix=$1 bin=$2 current='' mask command placed adapter entry quoted
  [[ ! -f "$prefix/current" ]] || current=$(cat "$prefix/current")
  mask=$(umask)
  umask 022
  mkdir -p "$prefix/releases" "$bin" || refuse "Kit could not be placed in $prefix"
  if [[ "$current" != "$VERSION" && ! -d "$prefix/releases/$VERSION" ]]; then
    rm -rf "$prefix/placing" && mkdir -p "$prefix/placing/release" || refuse "Kit could not be placed in $prefix"
    trust_extra_authorities "$prefix/placing"
    if [[ -n "$current" && "$(cat "$prefix/releases/$current/node.sha256" 2>/dev/null)" == "$NODE_SHA256" ]]; then
      printf 'Downloading Kit %s from %s.\n' "$VERSION" "$HOUSE"
      for entry in "$prefix/releases/$current"/*; do
        [[ "${entry##*/}" == adapters ]] || cp -pR "$entry" "$prefix/placing/release/" || refuse "Kit could not be placed in $prefix"
      done
      chmod -R u+w "$prefix/placing/release" &&
        rm -rf "$prefix/placing/release/lib/node_modules/@agentshouse" "$prefix/placing/release/bin/kit" "$prefix/placing/release/bin/house" ||
        refuse "Kit could not be placed in $prefix"
    else
      printf 'Downloading Node.js %s and Kit %s from %s.\n' "$NODE_VERSION" "$VERSION" "$HOUSE"
      download Node.js "node-v$NODE_VERSION-$NODE_PLATFORM.tar.gz" "$NODE_SHA256" "$prefix/placing/node.tar.gz" "$NODE_BYTES"
      tar -xzf "$prefix/placing/node.tar.gz" -C "$prefix/placing/release" --strip-components=1 --no-same-owner || refuse 'Node.js could not be unpacked'
      printf '%s\n' "$NODE_SHA256" > "$prefix/placing/release/node.sha256" || refuse "Kit could not be placed in $prefix"
    fi
    download Kit "kit-$VERSION.tar.gz" "$KIT_SHA256" "$prefix/placing/kit.tar.gz"
    tar -xzf "$prefix/placing/kit.tar.gz" -C "$prefix/placing/release" --no-same-owner || refuse "Kit $VERSION could not be unpacked"
    for adapter in $ADAPTERS; do
      download "${adapter%=*}" "${adapter%=*}" "${adapter#*=}" "$prefix/placing/adapter.tar.gz"
      mkdir -p "$prefix/placing/release/adapters/${adapter%%-[0-9]*}" &&
        tar -xzf "$prefix/placing/adapter.tar.gz" -C "$prefix/placing/release/adapters/${adapter%%-[0-9]*}" --no-same-owner ||
        refuse "${adapter%=*} could not be unpacked"
    done
    mv "$prefix/placing/release" "$prefix/releases/$VERSION" && rm -rf "$prefix/placing" || refuse "Kit could not be placed in $prefix"
  fi
  quoted=${prefix//\'/\'\\\'\'}
  for command in kit house; do
    printf '#!/bin/sh\nprefix='"'"'%s'"'"'\nread -r release < "$prefix/current"\nexport NODE_USE_SYSTEM_CA=1 HOUSE_KIT_PREFIX="$prefix"\nPATH="$prefix/releases/$release/bin:$PATH" exec "$prefix/releases/$release/bin/%s" "$@"\n' "$quoted" "$command" > "$bin/$command.new" || refuse "$bin/$command could not be written"
    if cmp -s "$bin/$command.new" "$bin/$command"; then
      rm -f "$bin/$command.new"
    else
      chmod 0755 "$bin/$command.new" && mv -f "$bin/$command.new" "$bin/$command" || refuse "$bin/$command could not be written"
    fi
  done
  if [[ "$current" != "$VERSION" ]]; then
    printf '%s\n' "$VERSION" > "$prefix/current.new" && mv -f "$prefix/current.new" "$prefix/current" || refuse "Kit could not be placed in $prefix"
  fi
  for placed in "$prefix/releases"/*; do
    [[ "${placed##*/}" == "$VERSION" || "${placed##*/}" == "$current" ]] || rm -rf "$placed"
  done
  umask "$mask"
}

add_path_line() {
  local profile="$HOME/.profile" line="export PATH=\"$1:\$PATH\""
  case "${SHELL:-}" in
    */zsh) profile="$("$SHELL" -c 'printf "\n%s" "${ZDOTDIR:-$HOME}"' | tail -n 1)/.zprofile" ;;
    */bash)
      for profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
        [[ ! -f "$profile" ]] || break
      done
      ;;
    */fish)
      profile="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      line="set -gx PATH \"$1\" \$PATH"
      ;;
  esac
  grep -Fqx "$line" "$profile" 2>/dev/null && return
  if [[ -s "$profile" && -n "$(tail -c 1 "$profile")" ]]; then printf '\n' >> "$profile"; fi
  mkdir -p "${profile%/*}" && printf '%s\n' "$line" >> "$profile" || refuse "$profile could not be written"
  printf 'Added %s to the path in %s; new terminals find kit and house.\n' "$1" "$profile"
}

prepare_home() {
  if [[ -e "$KIT_HOME" || -L "$KIT_HOME" ]]; then
    [[ -d "$KIT_HOME" && ! -L "$KIT_HOME" && ( -e "$KIT_HOME/credential.json" || -e "$KIT_HOME/kit.json" || -e "$KIT_HOME/kit" ) ]] ||
      refuse "$KIT_HOME holds what is not Kit's; move it elsewhere, then run this command again"
  else
    mkdir -p "${KIT_HOME%/*}" && mkdir -m 700 "$KIT_HOME" || refuse "$KIT_HOME could not be created"
  fi
  [[ -O "$KIT_HOME" ]] || refuse "$KIT_HOME is not owned by this account"
}

notice_host() {
  local found=Linux contract distribution='' release=''
  if ((MACOS)); then
    found="macOS $MACOS_VERSION"
    contract="macOS $MACOS_RELEASE"
    ((${MACOS_VERSION%%.*} < MACOS_RELEASE)) || [[ "$CHIP" != "$CONTRACT_CHIP" ]] || return 0
  else
    if [[ -r /etc/os-release ]]; then
      distribution=$(. /etc/os-release && printf '%s' "${ID:-}")
      release=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
      found=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-$found}")
    fi
    contract="Ubuntu $NATIVE_RELEASE LTS"
    [[ "$distribution" != ubuntu || "$release" != "$NATIVE_RELEASE" || "$CHIP" != "$CONTRACT_CHIP" ]] || return 0
  fi
  if [[ "$CHIP" != "$CONTRACT_CHIP" ]]; then
    found+=" on $CHIP"
    contract+=" on $CONTRACT_CHIP"
  fi
  printf 'Warning: %s is outdated; update to %s.\n' "$found" "$contract"
}

read_host() {
  local adapter glibc
  [[ "$KIT_SHA256" =~ ^[0-9a-f]{64}$ && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] ||
    refuse 'this bootstrap has not been published with an immutable release'
  for adapter in $ADAPTERS; do
    [[ "$adapter" =~ ^[a-z][a-z0-9-]*-[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\.tar\.gz=[0-9a-f]{64}$ ]] ||
      refuse 'this bootstrap has not been published with an immutable release'
  done
  case "$(uname -s)" in
    Linux)
      case "$(uname -m)" in
        x86_64|amd64) CHIP=amd64 ;;
        aarch64|arm64)
          CHIP=arm64
          NODE_PLATFORM=linux-arm64
          NODE_SHA256=33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3
          NODE_BYTES=58021129
          ;;
        *) refuse "this Linux runs on $(uname -m), and Kit runs on amd64 and arm64" ;;
      esac
      glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || refuse 'this Linux has no glibc, and Kit needs glibc 2.28 or newer'
      glibc=${glibc##* }
      at_least "$glibc" "$NODE_GLIBC" || refuse "this Linux has glibc $glibc, and Kit needs glibc $NODE_GLIBC or newer"
      ;;
    Darwin)
      MACOS=1
      MACOS_VERSION=$(sw_vers -productVersion)
      at_least "$MACOS_VERSION" "$NODE_MACOS" || refuse "this Mac has macOS $MACOS_VERSION, and Kit needs macOS $NODE_MACOS or newer"
      CONTRACT_CHIP='Apple silicon'
      CHECKSUM=(shasum -a 256)
      if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" == 1 ]]; then
        CHIP='Apple silicon'
        NODE_PLATFORM=darwin-arm64
        NODE_SHA256=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7
        NODE_BYTES=53062778
      else
        CHIP='an Intel chip'
        NODE_PLATFORM=darwin-x64
        NODE_SHA256=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035
        NODE_BYTES=54382566
      fi
      ;;
    *) refuse "this bootstrap is for Linux and macOS, not $(uname -s)" ;;
  esac
}

while (($#)); do
  case "$1" in
    --house|--code)
      (($# >= 2)) || refuse "$1 requires one value"
      if [[ "$1" == --house ]]; then
        ((HOUSE_SELECTED == 0)) || refuse 'supply exactly one House origin'
        HOUSE="$2"
        HOUSE_SELECTED=1
      else
        ((${#CODE[@]} == 0)) || refuse 'supply exactly one login code'
        CODE=(--code "$2")
      fi
      shift 2
      ;;
    --place)
      (($# >= 2)) || refuse "$1 requires one value"
      PLACE="$2"
      PLACING=1
      shift 2
      ;;
    *) refuse "unknown argument $1" ;;
  esac
done
read_host
if ((PLACING)); then
  if [[ "$PLACE" == "$KIT_HOME/kit" ]]; then
    place_release "$PLACE" "$KIT_HOME/bin"
    add_path_line "$KIT_HOME/bin"
  else
    place_release "$PLACE" "$PLACE/bin"
  fi
  exit 0
fi
[[ "$HOUSE" == https://* || "$HOUSE" == http://127.0.0.1:* || "$HOUSE" == http://localhost:* ]] || refuse 'House origin must use HTTPS or local loopback HTTP'
notice_host
((MACOS)) || establish_native_packages
prepare_home
place_release "$KIT_HOME/kit" "$KIT_HOME/bin"
add_path_line "$KIT_HOME/bin"
exec "$KIT_HOME/bin/kit" connect --house "$HOUSE" ${CODE[@]+"${CODE[@]}"}
