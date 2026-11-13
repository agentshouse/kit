# Kit

Kit connects an Environment, a Linux computer or server, to [agents.house](https://agents.house). It runs
your Agents' conversations through the agent CLIs you chose and gives each Agent the `house` command.

## Install

Run `sh -c 'kit=$(curl -fsSL "$0") || { echo "Kit could not be downloaded; run this command again." >&2; exit 1; }; eval "$kit"' agents.house/kit`,
or `& { try { $kit = irm agents.house/kit.ps1 } catch { throw 'Kit could not be downloaded; run this command again.' }; & ([scriptblock]::Create($kit)) @args }` on Windows, which run nothing of a failed download, and again to update; `--code <code>` follows `agents.house/kit` to connect with a login code.
On macOS and Linux, a server included, it installs Kit natively under your own account, without an admin password, in one folder, `~/.agents/house`: Kit's own files at its top, its releases and their Node.js in `kit`, `kit` and `house` in `bin`, which it adds to your login shell's `PATH`, and your workspace, the Agents' folders in `agents` and the Rooms' copies in `local-copies`. It stops, changing nothing, where `~/.agents/house` holds something that is not Kit's. On Linux it adds a missing `ca-certificates`, `curl` or `git` through apt. Then `kit connect` keeps the Environment you connected, redeems the login code or prints a link you confirm, writes Kit's settings where `kit.json` has none, places House's Skills and starts Kit: as a systemd user unit that starts at boot through lingering on Linux, and as a LaunchAgent on macOS. On a Linux without systemd it starts nothing: run the `kit resident` command it prints under your own service manager, restarting it whenever it ends with a failure. One account runs one Kit for one Building; to move it to another, run `kit logout` and then the other Building's command.

Every run places the Kit release your Building serves, with the Node.js and agent adapters it runs on, in a directory of its own beside the one that runs, then starts it; the earlier one stays until the next release. Kit also updates itself: when your Building takes another release, Kit places it the same way and, once no turn is open, ends so its service starts it. When House no longer serves the wire of the Kit that runs, Kit places your Building's release at once, ending any running turn, and ends the same way; while it cannot, it stays offline, prints why with the command that installs it again, and tries again regularly.

A Kit installed before moves itself into `~/.agents/house` on its next update, a Mac's or a Linux desktop's and one running as root; one in a container or under a system unit of another account asks you, on its Environment's page, to run the install command again on that computer, which moves it and removes the container or the unit, keeping its Environment.

On Windows the command, run in PowerShell, installs WSL where it is absent, asking you to restart only where Windows needs that and to run the command again after, and Ubuntu where WSL has none, with a default user named after yours; it turns on WSL's Keep WSL running, starts Ubuntu, with no window, when you sign in, and installs Kit inside Ubuntu as on Linux. The Linux command run in a WSL terminal recommends the Windows command instead and installs and starts Kit there only once you agree that it then runs only while a WSL terminal is open, and not after a restart; with no terminal to ask in, it installs nothing and names the Windows command. A Kit that ran in Docker Desktop's `house-kit` container moves into Ubuntu as the same Environment, its workspace kept where it was, and the command removes the container, keeping its volume.

Kit is built for macOS 27 on Apple silicon, Ubuntu 26.04 LTS on amd64 and Windows 11 on amd64. On another release, distribution or architecture the command prints one warning line, such as `Warning: macOS 26.7.1 is outdated; update to macOS 27.`, and installs anyway. It refuses only an architecture other than amd64 and arm64, a macOS older than 13.5 and a Linux without glibc 2.28 or newer.

Kit runs each agent CLI through the link your login shell finds and installs a missing one through that CLI's own
installer. When it starts and regularly after, Kit runs each CLI's own update command, such as `claude update`, beside
your conversations: a running conversation keeps its version and the next one runs the new release. A CLI older than
the oldest release Kit is built for still runs, though its conversations may fail: Kit tells House its version, that
oldest release and its update command. Kit also gives every Agent on the Environment the agent skills of
`@agentshouse/skills`, at the version each Kit release installs, unless its `skills` setting is off.

## Commands

`kit login` opens or prints a link you confirm in any browser, on this computer or another, continues on its own and keeps the Environment's credential in `~/.agents/house`. `--environment <id>` reconnects an Environment you already have, which keeps its Rooms: its page in House changes them. A new Environment takes `--rooms <ref>[,<ref>...]` for only those Rooms and `--no-private` for every Room but your Private Room; `--code <code>` connects immediately without a link.
A login also connects your own agent: outside an Agent conversation, `house <tool>` calls
House as you and `git` clones and pushes your Apps at `<house>/app/` as you, each through the Kit
home of the account it runs as, until you revoke that connection on Connections. `house help` lists the Tools and `house help <tool>` one Tool's arguments. Codex sessions started after a
login run a lone `house` command outside their sandbox. `kit logout` disconnects this
computer, stops the Kit process and ends your own agent's connection, so `house` and `git` no
longer act as you here; a later `kit login` reconnects the same Environment, or connects
this computer as a new one when House no longer holds it.

`kit settings` prints Kit's two settings, which every update and every rerun of the install keep: `skills`, whether Kit places House's Skills, and `workspace`, the folder that holds `agents` and `local-copies`. `kit settings skills on|off` and `kit settings workspace <absolute path>` change one, as the Environment's page in House does.
A new workspace must hold no `agents` or `local-copies` folder, and none is taken while an Agent works; Kit then ends its conversations' processes, moves both folders there, across filesystems copying and checking them before it deletes the old ones, and ends so its service starts it there.

`kit resident` keeps the Environment connected and, as it connects, copies the text of each Room you chose for it as a
Git repository in the workspace's `local-copies`, and keeps a Room's copy as it is, no longer refreshing it, once the
Room may no longer be copied here. `house fetch` does the same and records House's changes on each copy's
`refs/house/received`; rebase onto it, commit and run `house push --owner` in the copy. An Agent runs both, without `--owner`. `house upload` and `house download` move a Room's other files straight between disk and House's store, and a broken upload resumes on its own.

Kit turns each audio file your message to an Agent links into text on this computer before the Agent reads it, and keeps a message whose audio it cannot turn into text from starting. While transcription is on, the speech engine and model use about 425 MB beside the Environment's credential; turning it off deletes them.

When you press Run on a Web Wizard's page, Kit runs its script with `bash` in a terminal on this computer, as you, in the home and directory it runs agent CLIs from, with your login shell's `PATH`; the page shows that terminal and takes your typing, and closing the page, or Kit losing its connection to House, ends the script and its child processes. Kit keeps nothing the script prints or you type. A script you keep as a function from a Web Wizard runs as you, from the same home, directory and `PATH`, when a Trigger of your Private Room or your agent runs it, with no terminal and nothing on its standard input, and when you press Run now on its page, in a terminal you can type into. Kit writes the run's input as JSON to a file only you can read, whose path is in `HOUSE_INPUT`, and deletes it when the run ends; it ends the script and its child processes at the run's time limit or when it loses its connection to House, and sends House the end of what the script printed, up to the run's output limit, without any line that holds a line you typed.

## License

MIT.
