<div align="center">

# Agathos-Bot

Tabletop game tools powered by the Agathos language

</div>

## Overview

Agathos provides a custom dice language for tabletop game tools. Its Discord
deployment runs on two Cloudflare Workers: a private Python evaluator and a
public TypeScript interaction Worker.

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

### Dice Language

Expressions support dice arithmetic, list comprehensions, arrays, and unary
d20 advantage/disadvantage. For example, `[d20 for i in 0:5]` evaluates five
rolls with compact dice details. Unary `+d20` gives advantage, and `-d20` gives
disadvantage.
Drop modifiers use `l` for lowest and `h` for highest, such as `4d6l1` to
drop the lowest die or `10d8h2` to drop the highest two dice. Modifiers can be
chained left to right, with each modifier applying to the remaining active
dice, for example `4d6l1h1`.

### Deployment

Agathos is deployed as two Cloudflare Workers: the private Python evaluator
(`agathos-evaluator`) and the public TypeScript Discord interaction Worker
(`agathos-interactions`). The evaluator is reached by Service Binding and does
not need Discord credentials. Deploy the evaluator first, then the interaction
Worker, and configure Discord's Interactions Endpoint URL to the public Worker
only after signed PING validation succeeds.

See [docs/cloudflare.md](docs/cloudflare.md) for local development, tests,
secrets, command registration, endpoint configuration, deployment, and
rollback instructions.
