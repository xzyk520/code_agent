---
name: hello-skill
description: Use when the user asks to test skill loading, or explicitly says "hello skill".
---

# Hello Skill

This is a deliberately small skill used to verify that Bee Code discovers and
loads user skills.

When this skill is active, follow these rules:

1. Start the reply with exactly: `SKILL-OK`
2. Then list exactly three short bullet points:
   - the skill name (`hello-skill`)
   - the phrase `loaded from SKILL.md`
   - one sentence confirming you followed this file
3. Do not add any other headings or commentary.

Example shape:

SKILL-OK
- hello-skill
- loaded from SKILL.md
- I followed this SKILL.md.