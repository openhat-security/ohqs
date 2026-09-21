# OS-level resources

Cannot submodule distro ISOs. Install a pentest environment, then use `ohqs setup`.

## Recommend

| Who | Choice |
| --- | --- |
| Most people / OSCP-shaped workflows | [Kali Linux](https://www.kali.org/) |
| macOS or “one container per engagement” | [Exegol](https://github.com/ThePorgs/Exegol) |
| Already on Arch | [BlackArch](https://www.blackarch.org/) overlay (`strap.sh`) |
| Lighter Debian daily driver | [Parrot OS](https://www.parrotsec.org/) |
| Windows lab | Commando VM |

## Kali

- Tools index: https://www.kali.org/tools/
- Metapackages: https://www.kali.org/docs/general-use/metapackages/
- Useful: `kali-tools-web`, `kali-tools-vulnerability`, `kali-tools-information-gathering`
- Everything: `kali-linux-everything` (huge)

## BlackArch

- Tools: https://www.blackarch.org/tools.html (~2800 packages)
- Install overlay: https://blackarch.org/downloads.html (`strap.sh`)
- Prefer slim/netinstall + `pacman -S blackarch-<category>` (`blackarch-webapp`, `blackarch-scanner`, `blackarch-recon`)
- Avoid the ~22GB full ISO unless you have a reason

```bash
curl -O https://blackarch.org/strap.sh
# verify checksum from the downloads page before running
chmod +x strap.sh
sudo ./strap.sh
sudo pacman -Syu
pacman -Sg | grep blackarch
```

## Exegol

https://exegol.com/install — Docker-based, good default on macOS.
