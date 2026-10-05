# House Kit

House Kit connects an Environment, a Linux computer or server, to
[agents.house](https://agents.house). It runs your Agents' conversations
through the agent CLIs you chose and gives each Agent the `house` command.

## Install

Connect a computer from agents.house. It gives you the one command that
installs House Kit on that computer and updates it when you run it again. On
macOS and Linux it installs House Kit natively under your own account, without
an admin password, as a service that runs while you are logged in. `kit` and
`house` are then on your login shell's `PATH`, and your workspace is
`~/AgentsHouse` unless you pass `--workspace <path>`.

Add `--container` to run House Kit in one Docker container instead, with your
workspace mounted at `/agents/house`; your Agents then reach only that
workspace. On Windows 11 the container is the one choice. Append a `kit` or
`house` command to the container's command to run it in that container.

On your own Ubuntu 26.04 server, run the Linux command with `--linux` to
install House Kit natively, with its workspace at `/agents/house`; `kit` and
`house` are then on the server's `PATH`.

House Kit also gives every Agent on the Environment a set of agent skills. Add
`--no-skills` to the command to leave them out; running it again without the
flag brings them back.

## Commands

`kit login` opens a link you confirm in your browser and keeps the
Environment's credential in `~/.house-kit`, or in `$HOUSE_KIT_HOME` when it is
set. Pass `--manual` to paste the code by hand on a machine without a browser,
and `--environment <id>` to reconnect an Environment you already have.

`kit resident` keeps the Environment connected, and keeps the Rooms you chose
for this Environment as Git repositories under `working-copies` in the
workspace. Commit in one and run `house git push --owner` there to send the
commit to House; in the container, run it through the install command from the
copy's directory. Inside an Agent conversation the Agent runs `house git push`.

## License

MIT

The skills come from [mattpocock/skills](https://github.com/mattpocock/skills); thank you, Matt Pocock.
