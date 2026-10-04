# House Kit

House Kit connects an Environment, a Linux computer or server, to
[agents.house](https://agents.house). It runs your Agents' conversations
through the agent CLIs you chose and gives each Agent the `house` command.

## Install

Connect a computer from agents.house. It gives you the one command that
installs House Kit on that computer and updates it when you run it again. On
Linux, macOS and Windows 11 it runs House Kit in one Docker container with
your workspace, `~/AgentsHouse` unless you pass `--workspace <path>`, mounted
at `/agents/house`. Append a `kit` or `house` command to the same command to
run it in that container.

On your own Ubuntu 26.04 server, run the Linux command with `--linux` to
install House Kit natively, with its workspace at `/agents/house`; `kit` and
`house` are then on the server's `PATH`.

## Commands

`kit login` opens a link you confirm in your browser and keeps the
Environment's credential in `~/.house-kit`, or in `$HOUSE_KIT_HOME` when it is
set. Pass `--manual` to paste the code by hand on a machine without a browser,
and `--environment <id>` to reconnect an Environment you already have.

`kit resident` keeps the Environment connected, and keeps the Rooms you chose
for this Environment as Git repositories under `/agents/house/working-copies`.
Commit in one and run `house git push --owner` there to send the commit to
House; on a computer, run it through the install command from the copy's
directory. Inside an Agent conversation the Agent runs `house git push`.

## License

MIT
