# House Kit

House Kit connects an Environment, a Linux computer or server, to
[agents.house](https://agents.house). It runs your Agents' conversations
through the agent CLIs you chose and gives each Agent the `house` command.

## Install

On a Linux server with Node.js 24:

```sh
npm install --global @agentshouse/kit
```

The image `ghcr.io/agentshouse/kit` runs the same Kit in a container for
`linux/amd64` and `linux/arm64`.

## Start

```sh
kit login
kit resident
```

`kit login` opens a link you confirm in your browser and keeps the
Environment's credential in `~/.house-kit`, or in `$HOUSE_KIT_HOME` when it is
set. Pass `--manual` to paste the code by hand on a machine without a browser,
and `--environment <id>` to reconnect an Environment you already have.
`kit resident` keeps the Environment connected.

## License

MIT
