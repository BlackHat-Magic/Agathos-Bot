from dotenv import load_dotenv
from discord.ext import commands
# from discord import app_commands, ButtonStyle
# from discord.ui import Button
import discord, os, re, random

load_dotenv()

intents = discord.Intents.default()
intents.message_content = True

client = commands.Bot(command_prefix="d!", intents=intents)
# secret advantage

@client.event
async def on_ready():
    print(f"Logged in as {client.user}.")
    try:
        synced = await client.tree.sync()
        print(f"Synced {len(synced)} command(s).")
    except Exception as e:
        print(e)

@client.tree.command(name="r", description="quickly roll a d20")
async def roll(interaction: discord.Interaction):
    await interaction.response.send_message(f"<@{interaction.user.id}> rolled a `[{random.randint(1, 20)}]`.")

@client.tree.command(name="roll", description="roll a die")
async def roll(interaction:discord.Interaction, expression: str, repeat: int = 1, reroll_below: int = 1, drop_lowest: int = 0, advantage_disadvantage: str = ""):
    if(repeat > 20):
        await interaction.response.send_message("Too many repetitions (max 20)", ephemeral=True)
        return
    response = ""
    cheat = False
    badcheat = False
    if("badcheat" in expression):
        expression = expression.replace("badcheat", "")
        response = "# Why would you do that...?\n\n" + response
        badcheat = True
    if("cheat" in expression):
        expression = expression.replace("cheat", "")
        response = "# CHEATER CHEATER 🎃🍴\n\n" + response
        cheat = True
    if(expression == ""):
        expression = "d20"
    response += f"<@{interaction.user.id}> Rolled: `[{expression}]`"

    adv_check = re.fullmatch(r"\+d20([+-]\d+)", expression)
    dis_check = re.fullmatch(r"\-d20([+-]\d+)", expression)

    if(bool(adv_check)):
        bonus = int(adv_check.group(1))
        for i in range(repeat):
            results = [random.randint(1, 20) for i in range(2)]
            response += f"\nRoll: `{results}` Result: {max(results) + bonus}"
        await interaction.response.send_message(response)
        return
    elif(bool(dis_check)):
        bonus = int(dis_check.group(1))
        for i in range(repeat):
            results = [random.randint(1, 20) for i in range(2)]
            response += f"\nRoll: `{results}` Result: {min(results) + bonus}"
        await interaction.response.send_message(response)
        return

    await interaction.response.defer()

    expressions = re.findall(r"([-+]?\d*d\d+|[-+]?\d+)", expression)
                
    dropped = []

    for i in range(repeat):
        total = 0
        drop = drop_lowest

        all_results = ""

        for expression in expressions:
            if("d" in expression):
                match = expression.split("d")

                num_dice = 1
                num_dice = match[0]
                if(num_dice == ""):
                    num_dice = 1
                else:
                    num_dice = int(num_dice)
                num_sides = int(match[1])
                if(int(num_dice) > 500):
                    await interaction.followup.send("Too many dice (max 500)", ephemeral=True)
                    return
                if(num_dice < 0):
                    num_dice *= -1
                    subtract = True
                else:
                    subtract = False
            
                die_results = []

                for i in range(num_dice):
                    if(cheat):
                        die_result = num_sides
                    elif(badcheat):
                        die_result = 1
                    else:
                        if(num_sides == 20 and advantage_disadvantage != ""):
                            die_result = [random.randint(1,20), random.randint(1,20)]
                        else:
                            die_result = random.randint(1, num_sides)
                    if(type(die_result) == int):
                        while die_result < reroll_below:
                            if(reroll_below > num_sides):
                                break
                            die_result = random.randint(1, num_sides)
                    else:
                        for result in die_result:
                            while result < reroll_below:
                                if(reroll_below > num_sides):
                                    break
                                result = random.randint(1, num_sides)
                    die_results.append(die_result)

                while drop > 0 and len(die_results) > 0:
                    dropped.append(min(die_results))
                    die_results.remove(min(die_results))
                    drop -= 1
                
                for result in die_results:
                    if(type(result) == list):
                        if(advantage_disadvantage in ["d", "dis", "disadv", "disadvantage"]):
                            if(subtract):
                                total -= min(result)
                            else:
                                total += min(result)
                            dropped.append(max(result))
                        else:
                            if(subtract):
                                total -= max(result)
                            else:
                                total += max(result)
                            dropped.append(min(result))
                    else:
                        if(subtract):
                            total -= result
                        else:
                            total += result

                all_results += str(die_results)
            else:
                total += int(expression)
        
        response += f"\nRoll: `{all_results}` Result: `{total}`"
        if(dropped != []):
            response += f"; Dropped: `{dropped}`"
        
    if(len(response) > 2000):
        await interaction.followup.send("Resulting expression was too long. Try rolling fewer dice or rolling with fewer repetitions.", ephemeral=True)
    
    await interaction.followup.send(response)

@client.tree.command(name="advantage", description="roll a d20 with advantage")
async def advantage(interaction: discord.Interaction, bonus: int = 0, repeat: int = 1):
    if(repeat > 20):
        await interaction.response.send_message("Too many repetitions (max 20)", ephemeral=True)
        return

    response = f"<@{interaction.user.id}> Rolled 1d20{'+'+str(bonus) if bonus > 0 else bonus if bonus < 0 else ''} with advantage."
    
    for i in range(repeat):
        results = [random.randint(1, 20) for i in range(2)]
        response += f"\nRoll: `{results}` Result: {max(results) + bonus}"
    
    await interaction.response.send_message(response)

@client.tree.command(name="disadvantage", description="roll a d20 with disadvantage")
async def disadvantage(interaction: discord.Interaction, bonus: int = 0, repeat: int = 1):
    if(repeat > 20):
        await interaction.response.send_message("Too many repetitions (max 20)", ephemeral=True)
        return

    response = f"<@{interaction.user.id}> Rolled 1d20{'+'+bonus if bonus > 0 else bonus if bonus < 0 else ''} with disadvantage."
    
    for i in range(repeat):
        results = [random.randint(1, 20) for i in range(2)]
        response += f"\nRoll: `{results}` Result: {min(results) + bonus}"
    
    await interaction.response.send_message(response)

client.run(os.getenv("DISCORD_CLIENT_TOKEN"))