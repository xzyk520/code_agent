"""Discover user-installed skills (Claude-style SKILL.md folders).

Workspace skills live in `<workspace>/.beecode/skills/<name>/SKILL.md`.
User-global skills may live in `~/.beecode/skills/<name>/SKILL.md`.
Only the index is injected into the system prompt; the full body is read on demand
through the `read_skill` tool.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class Skill:
    name: str
    description: str
    body: str
    path: str


def skills_roots() -> list[Path]:
    roots = [Path.cwd() / ".beecode" / "skills", Path.home() / ".beecode" / "skills"]
    unique: list[Path] = []
    for root in roots:
        resolved = root.resolve()
        if resolved not in unique:
            unique.append(resolved)
    return unique


def load_skills() -> list[Skill]:
    found: dict[str, Skill] = {}
    for root in skills_roots():
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            skill_file = entry / "SKILL.md"
            if not skill_file.is_file():
                continue
            try:
                text = skill_file.read_text(encoding="utf-8-sig", errors="replace")
            except OSError:
                continue
            name, description, body = _parse_skill(text, entry.name)
            found[name] = Skill(name=name, description=description, body=body, path=str(skill_file))
    return sorted(found.values(), key=lambda s: s.name.lower())


def skill_index(skills: list[Skill] | None = None) -> str:
    items = load_skills() if skills is None else skills
    if not items:
        return ""
    lines = ["Available user skills (call read_skill(name) to load instructions):"]
    for skill in items[:40]:
        desc = skill.description[:240]
        lines.append(f"- {skill.name}: {desc}")
    return "\n".join(lines)


def read_skill(name: str) -> Skill | None:
    wanted = name.strip().lower()
    for skill in load_skills():
        if skill.name.lower() == wanted:
            return skill
    return None


def _parse_skill(text: str, fallback_name: str) -> tuple[str, str, str]:
    name = fallback_name
    description = ""
    body = text
    if text.startswith("---"):
        parts = text.splitlines()
        end = None
        for index in range(1, min(len(parts), 80)):
            if parts[index].strip() == "---":
                end = index
                break
        if end is not None:
            for line in parts[1:end]:
                key, _, value = line.partition(":")
                if key.strip().lower() == "name" and value.strip():
                    name = value.strip().strip("\"'")
                elif key.strip().lower() == "description" and value.strip():
                    description = value.strip().strip("\"'")
            body = "\n".join(parts[end + 1 :]).strip()
    if not description:
        for line in body.splitlines():
            candidate = line.strip().lstrip("#").strip()
            if candidate:
                description = candidate
                break
    return name, description or name, body
