<div align="center">

# Agathos-Bot

Tabletop game tools powered by the Agathos language

</div>

## Overview

Agathos provides a custom dice language for tabletop game tools. Its Discord
deployment is being migrated to Cloudflare Workers. The Python evaluator Worker
exists, while the public TypeScript interaction Worker and final deployment
documentation are still being completed.

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

Cloudflare deployment is in progress. The Python evaluator Worker is available;
the public TypeScript interaction Worker and final deployment documentation are
still being completed.
