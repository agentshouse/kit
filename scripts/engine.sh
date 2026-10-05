#!/bin/sh
set -eu

WHISPER_TAG=v1.9.4
WHISPER_COMMIT=927cfce34f31707e17f2bff35c349632fb9e2c3a
FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e

out=$(realpath "$1")
arch=$(uname -m)
work=$(mktemp -d)
mkdir -p "$out"

apk add --no-cache build-base cmake curl git linux-headers xz >/dev/null

git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git "$work/whisper"
[ "$(git -C "$work/whisper" rev-parse HEAD)" = "$WHISPER_COMMIT" ]
case "$arch" in
  x86_64) cpu='-DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_BMI2=ON -DGGML_FMA=ON -DGGML_F16C=ON' ;;
  aarch64) cpu='-DGGML_CPU_ARM_ARCH=armv8-a' ;;
esac
cmake -S "$work/whisper" -B "$work/whisper/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF $cpu -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
  -DCMAKE_EXE_LINKER_FLAGS=-static >/dev/null
cmake --build "$work/whisper/build" --target parakeet-cli -j "$(nproc)" >/dev/null
strip -o "$out/parakeet-cli-linux-$arch" "$work/whisper/build/bin/parakeet-cli"

curl -fsSL -o "$work/ffmpeg.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
printf '%s  %s\n' "$FFMPEG_SHA256" "$work/ffmpeg.tar.xz" | sha256sum -c - >/dev/null
tar -xJf "$work/ffmpeg.tar.xz" -C "$work"
cd "$work/ffmpeg-$FFMPEG_VERSION"
./configure --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-network \
  --disable-ffplay --disable-ffprobe --disable-x86asm --enable-static --disable-shared --extra-ldflags=-static \
  --enable-protocol=file,pipe \
  --enable-demuxer=ogg,matroska,mov,mp3,wav,aac,flac \
  --enable-parser=opus,vorbis,aac,aac_latm,mpegaudio,flac \
  --enable-decoder=opus,vorbis,aac,aac_latm,mp3,mp3float,flac,alac,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8,pcm_alaw,pcm_mulaw \
  --enable-filter=aresample,aformat,anull \
  --enable-encoder=pcm_s16le --enable-muxer=wav,segment >/dev/null
make -j "$(nproc)" ffmpeg >/dev/null
strip -o "$out/ffmpeg-linux-$arch" ffmpeg
./ffmpeg -hide_banner -buildconf | grep -q -- '--enable-gpl' && exit 1
./ffmpeg -hide_banner -buildconf | grep -q -- '--enable-nonfree' && exit 1
cd "$out"
sha256sum ./*-linux-"$arch"
