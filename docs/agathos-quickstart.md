# Agathos DSL Quickstart

Agathos is a small dice language for tabletop games. You can use it like a
calculator for a single roll, or keep values around while you build a more
useful game aid.

This guide starts with things a player or game master might type during a
session. The last section introduces a little programming for readers who want
to automate a repeated rule. You do not need to use functions or loops for the
common rolls.

## Start The REPL

From the repository root, start the interactive interpreter:

```sh
python -m language.repl
```

The `>>>` prompt accepts one expression at a time. Type `exit` or `quit` to
leave. Dice results are random, so your totals will be different from the
examples in this guide. A roll result includes a total and compact details such
as the dice values and any dropped dice.

## Your First Rolls

Suppose you need a straightforward d20 check:

```text
d20
```

`d20` means one twenty-sided die. The result is a total from 1 through 20.

Roll two six-sided dice and add them together:

```text
2d6
```

The general pattern is `number-of-dice` followed by `d` and the number of
sides. For example, `3d8` rolls three eight-sided dice.

Add a weapon or ability modifier with ordinary arithmetic:

```text
1d8 + 3
```

You can also use Agathos as a normal calculator:

```text
10 + 2 * 3
```

Try changing `d8` to `d10`, or change the modifier from `3` to your character's
actual bonus.

## Common 5e Rolls

### Ability Scores

The familiar 5e ability-score method is four six-sided dice, keeping the best
three:

```text
4d6l1
```

The `l1` modifier drops the lowest one die. The remaining three values make the
score.

### Damage

A weapon that deals 1d8 damage with a +3 modifier can be written as:

```text
1d8 + 3
```

The dice details let you see the die roll separately from the final total.

### Advantage And Disadvantage

For a plain, single d20 check, unary plus and minus have a useful 5e meaning:

```text
+d20
-d20
```

`+d20` rolls with advantage and keeps the higher result. `-d20` rolls with
disadvantage and keeps the lower result.

This special behavior is intentionally narrow. `+d6`, `+2d20`, and a modified
expression such as `+(d20 + 5)` are ordinary unary arithmetic, not advantage or
disadvantage. Add the modifier outside the advantage roll instead:

```text
+d20 + 5
```

Try replacing the bonus with your character's proficiency or ability modifier.

## Dice Adjustments

Agathos can apply adjustments directly to a group of dice. The number after a
modifier is its threshold or count.

| Expression | Meaning |
| --- | --- |
| `3d6b3` | Reroll a die when it is below 3. |
| `3d6a3` | Reroll a die when it is above 3. |
| `3d6m3` | Replace any value below 3 with 3. |
| `3d6x3` | Replace any value above 3 with 3. |
| `4d6l1` | Drop the lowest one die. |
| `4d6h1` | Drop the highest one die. |

Modifiers can be chained from left to right. For example, this rolls four d6s,
drops the lowest, then drops the highest of the remaining dice:

```text
4d6l1h1
```

Use `b` or `a` when a rule calls for rerolling an unlucky or unusually high
result. Use `m` or `x` when a rule says a die cannot go below or above a limit.

## Checks And Decisions

You can ask whether a roll meets a target directly. This is a +5 check against
DC 15:

```text
d20 + 5 >= 15
```

The result is `True` or `False`. Change `5` to the character's bonus or `15` to
the target DC.

For a friendly message instead of a boolean, use a small conditional:

```text
if d20 + 5 >= 15 { yield "success"; } else { yield "miss"; }
```

The condition is evaluated first. The matching branch yields the text shown by
the REPL. You can replace the strings with any short message you prefer.

## Save Useful Values

### Variables

When a value has a name, you can reuse it. `:=` creates a binding:

```text
bonus := 4
d20 + bonus
```

Run those lines in the same REPL session. The second submission can use
`bonus` because the REPL keeps bindings between submissions. This is useful for
keeping a character's attack bonus, spell save DC, or initiative modifier in
one place.

### Lists And Random Names

Arrays use square brackets. List indexes start at zero, so the first item is at
index `0`:

```text
names := ["Aria", "Bram", "Cora", "Dain", "Eris", "Fenn"]
names[d6 - 1]
```

The d6 produces a value from 1 through 6. Subtracting one turns it into a safe
index from 0 through 5 for this six-name list. Replace the names with towns,
treasures, tavern rumors, or anything else you want to pick randomly.

### Ranges And Comprehensions

A range creates a sequence of values. Its end is not included:

```text
0:6
```

This produces `[0, 1, 2, 3, 4, 5]`. A comprehension evaluates an expression for
each item in a range or list:

```text
[4d6l1 for score in 0:6]
```

This rolls six ability scores. `score` is the name of the current range item;
it is only being used to repeat the expression here and could have another
identifier name.

Comprehensions can also transform existing values:

```text
[item * 2 for item in [1, 2, 3]]
```

For a small batch of attack rolls, use the same pattern:

```text
[d20 + 5 for attempt in 0:4]
```

The result is a list containing four roll results. This is often easier to read
than writing the same roll four times.

## Optional: Small Programming Extensions

You can stop after the previous section and still use Agathos for common game
needs. These examples are for readers who want to package a repeated rule.

### A Small Function

This function gives a named form to an attack roll:

```text
attack :: int (bonus: int) { return d20 + bonus; }; attack(5)
```

`attack` is the function name. The `int` before the parameter list says the
function returns an integer, and `bonus: int` says its parameter is an integer.
The function returns a d20 plus the supplied bonus, and `attack(5)` calls it.

### A Small Loop

A loop is useful when you need to update one value repeatedly. This adds three
ability modifiers:

```text
total := 0; for score in [10, 12, 14] { total += score; }; total
```

The loop runs once for each item in the list. `+=` updates the existing
`total` binding, and the final `total` is the displayed result. When you want
to produce a new list, prefer a comprehension instead.

## Quick Reference

| Syntax | Use |
| --- | --- |
| `d20`, `3d6` | Roll one or more dice. |
| `+`, `-`, `*`, `/` | Ordinary arithmetic. |
| `>=`, `<=`, `==` | Compare values. |
| `+d20`, `-d20` | Advantage or disadvantage for a plain d20. |
| `b`, `a` | Reroll below or above a threshold. |
| `m`, `x` | Enforce a minimum or maximum value. |
| `l`, `h` | Drop the lowest or highest dice. |
| `name := value` | Create a named value. |
| `[a, b, c]` | Create a list. |
| `values[index]` | Read one list item; indexes start at zero. |
| `start:stop` | Create a range, excluding `stop`. |
| `[expression for item in values]` | Build a list with a comprehension. |
| `if ... { ... } else { ... }` | Choose between two branches. |
| `yield value` | Produce a value from a conditional or loop block. |
| `name :: int (value: int) { ... }` | Define a typed function. |
| `for item in values { ... }` | Repeat a block for each item. |

## Troubleshooting And Next Steps

- If the REPL prints `Error:`, check that the expression has balanced brackets,
  parentheses, and braces, and that each modifier has a number after it.
- List indexes must be valid. For a six-item list, `list[6]` is outside the
  list; use an index from `0` through `5`.
- Normal REPL rolls are random and are not reproducible from the displayed
  expression alone. Tests can provide a seeded interpreter when exact results
  are needed.

For the language overview, see the [main README](../README.md). For the
implementation, browse [`language/`](../language/). The detailed behavior is
covered by [`tests/test_interpreter.py`](../tests/test_interpreter.py) and
[`tests/test_rolls.py`](../tests/test_rolls.py).
