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
- [X] list comprehension equivalent in custom language
- [ ] Clue
- [ ] Chess
- [ ] Checkers
- [ ] Catan?
- [ ] Risk?
- [ ] Card Games
- [ ] TTRPG VTT?
- [ ] Other classic/popular board games?

### Dice Commands

- `/r` rolls a d20.
- `/roll expression:<expression>` evaluates a dice expression.

Expressions support dice arithmetic, list comprehensions, arrays, and unary
d20 advantage/disadvantage. For example,
`/roll expression:[d20 for i in 0:5]` displays each roll with compact dice
details instead of exposing the interpreter's internal object representation.
Unary `+d20` gives advantage, and `-d20` gives disadvantage.
Drop modifiers use `l` for lowest and `h` for highest, such as `4d6l1` to
drop the lowest die or `10d8h2` to drop the highest two dice. Modifiers can be
chained left to right, with each modifier applying to the remaining active
dice, for example `4d6l1h1`.

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
