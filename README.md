# House Kit

House Kit connects an Environment, a Linux computer or server, to
[agents.house](https://agents.house). It runs your Agents' conversations
through the agent CLIs you chose and gives each Agent the `house` command.

## Install

Run `curl -fsSL agents.house/kit | sh`, or `irm agents.house/kit.ps1 | iex` on
Windows, and again to update; options follow `sh -s --`. On macOS and Linux it
installs House Kit natively under your own account, without an admin password,
as a service that runs while you are logged in. `kit` and `house` are then on
your login shell's `PATH`, and your workspace is `~/AgentsHouse` unless you
pass `--workspace <path>`.

Add `--container` to run House Kit in one Docker container instead, with your
workspace mounted at `/agents/house`; your Agents then reach only that
workspace. On Windows 11 the container is the one choice. Append a `kit` or
`house` command to the container's options to run it in that container.
Running the command for the other choice on a connected computer asks you to
confirm, then replaces its Environment, whose Agents end, with a new one.

On your own Ubuntu 26.04 server, run the Linux command with `--linux` to
install House Kit natively, with its workspace at `/agents/house`; `kit` and
`house` are then on the server's `PATH`.

House Kit runs the agent CLIs your login shell finds and installs a missing one
through that CLI's own installer. Running the command again offers to update
each CLI older than House Kit needs; add `--update-clis` to update every one to
its latest release without asking. House Kit also gives every Agent on the
Environment a set of agent skills. Add `--no-skills` to the command to leave
them out; running it again without the flag brings them back.

## Commands

`kit login` opens a link you confirm in your browser and keeps the
Environment's credential in `~/.house-kit`, or in `$HOUSE_KIT_HOME` when it is
set. Pass `--manual` to paste the code by hand on a machine without a browser,
and `--environment <id>` to reconnect an Environment you already have. It also
connects your own agent: `house <tool>` run outside an Agent conversation calls
House as you, until you revoke that connection on Connections. `house help`
lists the Tools. `kit logout` disconnects this computer and stops House Kit; a
later `kit login` reconnects the same Environment.

`kit resident` keeps the Environment connected, and keeps the Rooms you chose
for this Environment as Git repositories under `local-copies` in the
workspace. Commit in one and run `house push --owner` there to send the
commit to House; in the container, run it through the install command from the
copy's directory. Inside an Agent conversation the Agent runs `house push`.

House Kit turns each audio file of your message to an Agent into text on this
computer before the Agent reads it. While transcription is on, the speech
engine and model use about 425 MB in `~/.house-kit`; turning it off deletes them.

## License

MIT

The skills come from [mattpocock/skills](https://github.com/mattpocock/skills); thank you, Matt Pocock.
