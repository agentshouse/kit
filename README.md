# House Kit

House Kit connects an Environment, a Linux computer or server, to
[agents.house](https://agents.house). It runs your Agents' conversations
through the agent CLIs you chose and gives each Agent the `house` command.

## Install

Connect a computer from agents.house. It gives you the one command that
installs House Kit on that computer and updates it when you run it again.

## Commands

`kit login` opens a link you confirm in your browser and keeps the
Environment's credential in `~/.house-kit`, or in `$HOUSE_KIT_HOME` when it is
set. Pass `--manual` to paste the code by hand on a machine without a browser,
and `--environment <id>` to reconnect an Environment you already have.

`kit resident` keeps the Environment connected.

## License

MIT
