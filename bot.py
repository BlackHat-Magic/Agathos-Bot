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

@client.tree.command(name="roll", description="roll a die")
async def roll(interaction:discord.Interaction, expression: str, repeat: int = 1, reroll_below: int = 1, drop_lowest: int = 0):
    expressions = re.findall(r"\d*d\d+", expression)

    response = f"<@{interaction.user.id}> Rolled: [{expression}]"
    if(repeat > 20):
        await interaction.response.send_message("Too many repetitions (max 20)", ephemeral=True)
        return

    for i in range(repeat):
        total = 0
        drop = drop_lowest

        all_results = ""

        for expression in expressions:
            match = re.match(r"(\d*)d(\d+)", expression)

            num_dice = 1
            if(match.group(1)):
                num_dice = match.group(1)
            if(int(num_dice) > 500):
                await interaction.response.send_message("Too many dice (max 500)", ephemeral=True)
                return
            
            num_sides = int(match.group(2))
            if(num_sides * int(num_dice) > 1500 * repeat):
                await interaction.response.send_message("Number of dice * number of sides per die * number of repetitions cannot exceed 1500 since the bot is limited to sending messages that are 2000 characters or less.", ephemeral=True)
                return
            die_results = []

            for i in range(int(num_dice)):
                die_result = random.randint(1, num_sides)
                while die_result < reroll_below:
                    dire_result = random.randint(1, num_sides)
                die_results.append(die_result)
            
            dropped = []

            while drop > 0:
                dropped.append(min(die_results))
                die_results.remove(min(die_results))
                drop -= 1
            
            for result in die_results:
                total += result

            all_results += str(die_results)
        
        response += f"\nRoll: `{all_results}` Result: `{total}`"
        if(dropped != []):
            response += f"; Dropped: `{dropped}`"
    
    await interaction.response.send_message(response)

client.run(os.getenv("DISCORD_CLIENT_TOKEN"))