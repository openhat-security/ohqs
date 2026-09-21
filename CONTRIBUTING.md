# Contributing

Add catalog records, not random clones.

1. Add or edit a record in `catalog/*.yaml` (`tools`, `extensions`, `guides`, `os`, `platforms`, `references`, `external`). Include `how`, `look_for`, `interpret`, and `commands` when the item is something `ohqs` might run.
2. If the project is a git repo we should vendor, add it as a **shallow submodule** under `third-party-resources/` (`git submodule add --depth 1 <url> <path>`) and set `submodule_path`. Do not commit a full nested clone. Users fetch trees with `make submodules` or `ohqs submodules`; they are not part of a default clone.
3. Do not paste exploit payloads into the catalog.
4. Run `make index` and `make search Q=<name>` locally. `ohqs install` only fetches a checkout when a playbook needs that tool and it is not already on PATH.

Playbook skeletons live in `catalog/playbooks/`.
