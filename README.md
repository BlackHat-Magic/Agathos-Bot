<div align="center">

# Agathos-Bot

Discord bot for tabletop game tools

</div>

## Overview

Discord bot for dice rolling and soon (tm) other stuff. Use `/roll` to roll a die.

### Goals

N/A

### Features

- [X] Arbitrary dice rolling
- [ ] list comprehension equivalent in custom language
- [ ] option and result types in custom language
- [ ] Clue
- [ ] TTRPG VTT?
- [ ] Other classic/popular board games?

### Software Stack / Technologies Used

- Language: Python
- Framework: discord.py
- Database: N/A (for now?)

## Quickstart

Permissions Integer: 448824461376

To build (moreso a note to self):

```bash
docker build -t your-dockerhub-username/your-bot-name:latest .
```

To run:

```bash
docker run -d --name your-bot-container -e DISCORD_CLIENT_TOKEN="YOUR_BOT_TOKEN" BlackHatMagic/Agathos-Bot:latest
```
