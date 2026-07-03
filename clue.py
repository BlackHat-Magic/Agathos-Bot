from __future__ import annotations
from enum import StrEnum
from dataclasses import dataclass
from typing import Literal

import random

from rapidfuzz import fuzz

class Suspect(StrEnum):
	MISS_SCARLETT	= "Miss Scarlett"
	PROFESSOR_PLUM	= "Professor Plum"
	MRS_PEACOCK		= "Mrs. Peacock"
	COLONEL_MUSTARD	= "Colonel Mustard"
	MR_GREEN		= "Mr. Green"
	MRS_WHITE		= "Mrs. White"
STARTING_POSITIONS = {	# board is 24 in width, 25 in height
	Suspect.MISS_SCARLETT:		(16,	24),
	Suspect.PROFESSOR_PLUM:		(0,		19),
	Suspect.MRS_PEACOCK:		(0,		6),
	Suspect.COLONEL_MUSTARD:	(23,	17),
	Suspect.MR_GREEN:			(9,		0),
	Suspect.MRS_WHITE:			(14,	0),
}

class Weapon(StrEnum):
	CANDLESTICK	= "Candlestick"
	DAGGER		= "Dagger"
	LEAD_PIPE	= "Lead Pipe"
	REVOLVER	= "Revolver"
	ROPE		= "Rope"
	WRENCH		= "Wrench"

class Room(StrEnum):
	BALLROOM		= "Ballroom"
	BILLIARD_ROOM	= "Billiard Room"
	CONSERVATORY	= "Conservatory"
	DINING_ROOM		= "Dining Room"
	HALL			= "Hall"
	KITCHEN			= "Kitchen"
	LIBRARY			= "Library"
	LOUNGE			= "Lounge"
	STUDY			= "Study"

@dataclass
class SuspectCard:
	suspect: Suspect
	type: Literal["suspect"] = "suspect"
@dataclass
class WeaponCard:
	weapon: Weapon
	type: Literal["weapon"] = "weapon"
@dataclass
class RoomCard:
	room: Room
	type: Literal["room"] = "room"
Card = SuspectCard | WeaponCard | RoomCard

@dataclass
class BoardSpace:
	room: Room | None = None
	accesses: list[BoardSpace] = []	# TODO list type hint
	pos: tuple[int, int] | None = None

@dataclass
class SuspectPiece:
	suspect: Suspect
	location: BoardSpace
	type: Literal["suspect"] = "suspect"
@dataclass
class WeaponPiece:
	weapon: Weapon
	location: BoardSpace
	type: Literal["weapon"] = "weapon"
GamePiece = SuspectPiece | WeaponPiece

@dataclass
class Player:
	name: str
	piece: SuspectPiece
	index: int = 0
	failed_guess: bool = False
	cards: list[Card] = []
	is_robot: bool = False
	guessed_here: bool = False

DEFAULT_SUSPECTS = [suspect for suspect in Suspect]
DEFAULT_WEAPONS = [weapon for weapon in Weapon]
DEFAULT_ROOMS = [room for room in Room]

class Game:
	def __init__(self, players: list[Player]) -> None:
		self.players: list[Player] = players.sort(key=lambda x: x.index)
		self.solution: tuple[SuspectCard, WeaponCard, RoomCard] | None = None

		ballroom		= BoardSpace(room=Room.BALLROOM)
		billiard_room	= BoardSpace(room=Room.BILLIARD_ROOM)
		conservatory	= BoardSpace(room=Room.CONSERVATORY)
		dining_room		= BoardSpace(room=Room.DINING_ROOM)
		hall			= BoardSpace(room=Room.HALL)
		kitchen			= BoardSpace(room=Room.KITCHEN)
		library			= BoardSpace(room=Room.LIBRARY)
		lounge			= BoardSpace(room=Room.LOUNGE)
		study			= BoardSpace(room=Room.STUDY)

		self.board: list[list[BoardSpace | None]] = [[None] * 25] * 24
		for col in range(24):
			for row in range(25):
				match (col, row):
					case (x, y) if (10 <= x <= 13 and y == 1) or (8 <= x <= 15 and 2 <= y <= 7):
						self.board[x][y] = ballroom
					case (x, y) if (x <= 5 and 8 <= y <= 12):
						self.board[x][y] = billiard_room
					case (x, y) if (x <= 5 and 1 <= y <= 4) or (1 <= x <= 4 and y == 5):
						self.board[x][y] = conservatory
					case (x, y) if (19 <= x <= 23 and y == 9) or (16 <= x <= 23 and 10 <= y <= 15):
						self.board[x][y] = dining_room
					case (x, y) if (9 <= x <= 14 and 18 <= y <= 23):
						self.board[x][y] = hall
					case (x, y) if (18 <= x <= 23 and y <= 5) or (18 <= x <= 22 and y == 6):
						self.board[x][y] = kitchen
					case (x, y) if (1 <= x <= 5 and y in [14, 18]) or (x <= 6 and 15 <= y <= 17):
						self.board[x][y] = library
					case (x, y) if 17 <= x and 19 <= y and not (x == 17 and y == 24):
						self.board[x][y] = lounge
					case (x, y) if x <= 6 and 21 <= y and not (x == 6 and y == 24):
						self.board[x][y] = study
					case (0, y) if y not in [6, 19]:
						pass
					case (23, y) if y not in [7, 17]:
						pass
					case (x, 0) if x not in [9, 14]:
						pass
					case (x, 24) if x not in [7, 16]:
						pass
					case (_, _):
						self.board[col][row] = BoardSpace(pos=(col, row))
		ballroom.accesses = [
			self.board[7][5],
			self.board[9][8],
			self.board[14][8],
			self.board[16][5]
		]
		billiard_room.accesses = [
			self.board[6][9],
			self.board[1][13]
		]
		conservatory.accesses = [
			lounge,
			self.board[5][5]
		]
		dining_room.accesses = [
			self.board[15][12],
			self.board[16][16]
		]
		hall.accesses = [
			self.board[11][17],
			self.board[12][17],
			self.board[8][20]
		]
		kitchen.accesses = [
			study,
			self.board[19][7]
		]
		library.accesses = [
			self.board[3][13],
			self.board[7][16]
		]
		lounge.accesses = [
			conservatory,
			self.board[17][18]
		]
		study.accesses = [
			kitchen,
			self.board[6][20]
		]

		for col in self.board:
			for space in col:
				if space is None:
					return
				if space.room or space.accesses or space.pos is None:
					return
				col_, row_ = space.pos
				for x in [col_ - 1, col_, col_ + 1]:
					for y in [row_ - 1, row_, row_ + 1]:
						if x < 0 or x > 23 or y < 0 or y > 24:
							continue
						if (x, y) == space.pos:
							continue
						if x != row_ and y != col_:
							continue
						accessee = self.board[x][y]
						if accessee is None:
							continue
						if accessee.room and space not in accessee.accesses:
							continue
						space.accesses.append(accessee)

	def begin(self) -> None:
		"""
		Begin the game
		"""

		remaining_cards = self._select_solution()
		self._deal(remaining_cards)

	def _select_solution(self) -> list[Card]:
		suspect_cards = [SuspectCard(suspect=suspect) for suspect in Suspect]
		weapon_cards = [WeaponCard(weapon=weapon) for weapon in Weapon]
		room_cards = [RoomCard(room=room) for room in Room]

		suspect = random.choice(suspect_cards)
		weapon = random.choice(weapon_cards)
		room = random.choice(room_cards)
		self.solution = (suspect, weapon, room)

		suspect_cards.remove(suspect)
		weapon_cards.remove(weapon)
		room_cards.remove(room)
		remaining = suspect_cards + weapon_cards + room_cards
		random.shuffle(remaining)

		return remaining

	def _deal(self, cards: list[Card]) -> None:
		i = 0
		while cards:
			self.players[i].cards.append(cards.pop(0))
			i = i + 1 % len(self.players)

def _create_human_players(n: int, suspects: list[Suspect]) -> list[Player]:
	players: list[Player] = []

	for i in range(n):
		name = input(f"What is player {i+1}'s name? ").strip()

		suspect: Suspect | None = None
		while True:
			print(f"Which suspect would player {i+1} like to play?")
			for j, sus in enumerate(suspects):
				print(f"[{i+1}]\t{sus.name}")
			inp = input("> ").casefold().strip()

			try:
				idx = int(inp)
				suspect = suspects[idx-1]
				break
			except (ValueError, IndexError):
				suspect = max(suspects, key=lambda x: fuzz.ratio(inp, x.name.casefold()))
				break

			confirmation = input(f"Selected {suspect.name}. Correct? [Y/n] ").casefold().strip()
			if confirmation not in ["n", "no"]:
				break

			continue
		print()

		players.append(Player(
			index=0,
			name=name,
			failed_guess=False,
			piece=SuspectPiece(
				suspect=suspect,
				location=STARTING_POSITIONS[suspect]	# TODO: fix starting pos
			),
			cards=[],
			is_robot=False
		))

	return players

def _create_robot_players(n: int, suspects: list[Suspect]) -> list[Player]:
	players: list[Player] = []

	for i in range(n):
		suspect = suspects[i]
		players.append(Player(
			index=0,
			name=suspect.name,
			failed_guess=False,
			piece=SuspectPiece(
				suspect=suspect,
				location=STARTING_POSITIONS[suspect]	# TODO: fix starting pos
			),
			cards=[],
			is_robot=True
		))

	return players

def _confirm_turn_order(players: list[Player]) -> None:
	players.sort(key=lambda x: x.index)

	while True:
		print("Turn order will be as follows (skips in numbers allowed):")
		for i, player in enumerate(players):
			print(f"[{i+1}]\t{player.name}")
		confirmation = ("Change? [y/N] ").casefold().strip()
		if confirmation not in ["y", "ye", "yes"]:
			break
		for player in players:
			while True:
				new_index = input(
					f"New index for {player.name} (currently {player.index}; blank to keep): "
				).strip()
				if new_index == "":
					break
				try:
					player.index = int(new_index)
					break
				except ValueError:
					print("Enter a number or leave blank.")
		print()

	players.sort(key=lambda x: x.index)

def _pathfind(
	piece: SuspectPiece,
	board: list[list[BoardSpace | None]],
	limit: int
) -> tuple[list[BoardSpace], list[int]]:
	if limit <= 0:
		return ([], [])

	source = piece.location

	space_queue: list[tuple[BoardSpace, int]] = []	# space : cost
	visited: dict[BoardSpace, int] = {}				# space : cost

	for space in source.accesses:
		space_queue.append((space, 1))

	while space_queue:
		space, cost = space_queue.pop(0)
		existing = visited.get(space)
		if space == source:
			continue
		if cost > limit:
			continue
		if existing is not None:
			if cost >= existing:
				continue
			else:
				visited[space] = cost
		for accessee in space.accesses:
			if space.room:
				space_queue.append((accessee, cost))
			else:
				space_queue.append((accessee, cost+1))

	reachable = (sorted(visited.keys(), key=lambda x: visited[x]), sorted(visited.values()))
	return reachable

def _play_game(game: Game) -> None:
	for player in game.players:
		if player.failed_guess:
			continue
		print(f"Beginning {player.name}'s turn...")

		if not player.is_robot:
			print(f"\t{player.name} cards in hand:")
			for card in player.cards:
				print(f"\t- {card}")

		# do we want to roll the dice?
		dice_conf = True
		if player.is_robot and not player.guessed_here:
			dice_conf = False
		else:
			dice_conf = player.guessed_here \
				or input("\tRoll dice to move? [Y/n] ").casefold().strip() not in ["n", "no"]

		# dice rolling
		if dice_conf:
			die_result = 0
			one, two = (0, 0)
			while one == two:
				one, two = random.randint(1, 6), random.randint(1, 6)
				die_result += one + two
			print(f"\tDie result: {die_result}")
			dests, costs = _pathfind(player.piece, game.board, die_result)
			destination: BoardSpace | None = None
			if player.is_robot:	# computers choose the farthest room (or farthest space)
				destination = max(
					zip(dests, costs),
					key=lambda x: x[1]+100 if x[0].room else x[1]
				)[0]
				dst_str = destination.room.name if destination.room else str(destination.pos)
				print(f"\t{player.name} went to space {dst_str}.")
			elif any([space.room for space in dests]):	# only show rooms for brevity
				rooms = [dest for dest in dests if dest.room]
				while True:
					print("\tChoose a room to go to:")
					n_options = 1
					for i, space in enumerate(rooms):
						print(f"\t[{i+1}]\t{space.room.name}")
						n_options += 1
					print(f"\t[{n_options}]\t(Stay put)")
					inp = input("> ").casefold().strip()
					try:
						idx = int(inp)
						if idx == n_options:
							destination = player.piece.location
						destination = rooms[idx-1]
					except (ValueError, IndexError):
						destination = max(
							rooms,
							key=lambda x: fuzz.ratio(inp, x.room.name.casefold())
						)
						if fuzz.ratio(inp, "stay put") \
							> fuzz.ratio(inp, destination.room.name.casefold()):
							destination = player.piece.location
					inp = "n"
					if destination == player.piece.locations:
						inp = input("\tStay put? [Y/n] ").casefold().strip()
					else:
						inp = input(f"\tGo to space {destination.pos}? [Y/n] ").casefold().strip()
					if inp not in ["n", "no"]:
						break
			else:	# show all spaces if no room is reachable
				while True:
					print("\tChoose a space to go to:")
					n_options = 1
					for i, space in enumerate(dests):
						print(f"\t[i+1]\t{space.pos}")
						n_options += 1
					print(f"\t[{n_options}]\t(Stay put)")
					inp = input("> ").casefold().strip()
					try:
						idx = int(inp)
						if idx == n_options:
							destination = player.piece.location
						destination = dests[idx-1]
					except (ValueError, IndexError):
						continue
					dest_conf = "n"
					if destination == player.piece.locations:
						dest_conf = input("\tStay put? [Y/n] ").casefold().strip()
					else:
						dest_conf = input(
							f"\tGo to space {destination.pos}? [Y/n] "
						).casefold().strip()
					if dest_conf not in ["n", "no"]:
						destination = destination
						break
			if destination != player.piece.location:
				player.guessed_here = False
			print()

		# guess time
		guess: tuple[Suspect, Weapon, Room] | None = None
		guess_conf = player.piece.location.room is not None \
			and not player.guessed_here \
			and input("\tMake a guess now? [Y/n] ").casefold().strip() not in ["n", "no"]
		if guess_conf:
			if player.is_robot:
				guess = (
					random.choice([suspect for suspect in Suspect]),
					random.choice([weapon for weapon in Weapon]),
					player.piece.location.room
				)
			else:
				print("\tSelect a suspect to guess:")
				for i, suspect in enumerate(Suspect):
					print(f"\t[{i+1}]\t{suspect.name}")
				guess_suspect: Suspect | None = None	# finalized guess
				inp = "n"
				while True:
					inp = input("> ")
					try:
						idx = int(inp)
						guess_suspect = [suspect for suspect in Suspect][idx-1]
					except (ValueError, IndexError):
						guess_suspect = max(
							[suspect for suspect in Suspect],
							key=lambda x: fuzz.ratio(inp, x.name)
						)
					inp = input(f"\tGuess {guess_suspect.name}? [Y/n] ").casefold().strip()
					if inp not in ["n", "no"]:
						break
				print(f"\tGuessing {guess_suspect.name}...")
				print()

				print("\tSelect a murder weapon to guess:")
				for i, weapon in enumerate(Weapon):
					print(f"\t[{i+1}]\t{weapon.name}")
				guess_weapon: Weapon | None = None	# finalized guess
				while True:
					inp = input("> ")
					try:
						idx = int(inp)
						guess_weapon = [weapon for weapon in Weapon][idx-1]
					except (ValueError, IndexError):
						guess_weapon = max(
							[weapon for weapon in Weapon],
							key=lambda x: fuzz.ratio(inp, x.name)
						)
					inp = input(f"\tGuess {guess_weapon.name}? [Y/n] ").casefold().strip()
					if inp not in ["n", "no"]:
						break
				guess = guess_suspect, guess_weapon, player.piece.location.room
			print(
				f"\tGuessing {guess_suspect.name} with {guess_weapon.name} in ",
				player.location.room.name + "."
			)
			print()


		# evaluate guess
		if guess is not None:
			found_self = False
			for other in game.players:
				if other != player and not found_self:
					continue
				if other == player and not found_self:
					found_self = True
					continue
				if other == player and found_self:
					break
				matching_cards = [
					card for card in player.cards \
						if (card.type == "suspect" and card.suspect == guess[0]) \
						or (card.type == "weapon" and card.weapon == guess[1]) \
						or (card.type == "room" and card.room == guess[2])
				]
				shown_card: Card | None = None	# finalized card to show
				if other.is_robot:
					shown_card = random.choice(matching_cards)
				else:
					while True:
						inp = input("\tChoose a card to show to {player.name}:")
						names = [
							card.suspect.name if card.type == "suspect" \
							else card.weapon.name if card.type == "weapon" \
							else card.room.name if card.type == "room" else "wrong" \
							for card in matching_cards
						]
						for i, name in enumerate(names):
							print(f"\t[{i+1}]\t{name}")
						inp = input("> ").casefold().strip()
						try:
							idx = int(inp)
							shown_card = matching_cards[idx-1]
						except (ValueError, IndexError):
							shown_card = max(
								zip(matching_cards, names),
								key=lambda x: fuzz.ratio(inp, x[1])
							)[0]
						name = card.suspect.name if card.type == "suspect" \
							else card.weapon.name if card.type == "weapon" \
							else card.room.name if card.type == "room" else "wrong"
						assert name != "wrong", "wtf??"
						inp = input(f"\tShow {card}? [Y/n] ")
						if inp not in ["n", "no"]:
							break
				if player.is_robot:
					print(f"\t{other.name} showed a card to {player.name}.")
				else:
					print(f"\tYou showed {shown_card} to {player.name}.")
		print()

		if player.is_robot:
			continue
		inp = input("\tMake an accusation now? [y/N] ").casefold().strip()
		if inp not in ["y", "ye", "yes"]:
			continue

		accused_suspect: Suspect | None = None	# finalized accusation
		print("\tChoose a suspect to accuse:")
		for i, suspect in enumerate(Suspect):
			print(f"\t[{i+1}]\t{suspect.name}")
		while True:
			inp = input("> ").casefold().strip()
			try:
				idx = int(inp)
				accused_suspect = [suspect for suspect in Suspect][idx-1]
			except (ValueError, IndexError):
				accused_suspect = max(
					[suspect for suspect in Suspect],
					key=lambda x: fuzz.ratio(inp, suspect.name)
				)
			inp = input(f"\tAccuse {suspect.name}? [Y/n] ").casefold().strip()
			if inp not in ["n", "no"]:
				break

		accused_weapon: Weapon | None = None
		print("\tChoose a weapon to accuse:")
		for i, weapon in enumerate(Weapon):
			print(f"\t[{i+1}]\t{weapon.name}")
		while True:
			inp = input("> ").casefold().strip()
			try:
				idx = int(inp)
				accused_weapon = [weapon for weapon in Weapon][idx-1]
			except (ValueError, IndexError):
				accused_weapon = max(
					[weapon for weapon in Weapon],
					key=lambda x: fuzz.ratio(inp, weapon.name)
				)
			inp = input(f"\tAccuse {weapon.name}? [Y/n] ").casefold().strip()
			if inp not in ["n", "no"]:
				break

		accused_room: Room | None = None
		print("\tChoose a room to accuse:")
		for i, room in enumerate(Room):
			print(f"\t[{i+1}]\t{room.name}")
		while True:
			inp = input("> ").casefold().strip()
			try:
				idx = int(inp)
				accused_room = [room for room in Room][idx-1]
			except (ValueError, IndexError):
				accused_room = max(
					[room for room in Room],
					key=lambda x: fuzz.ratio(inp, room.name)
				)
			inp = input(f"\tAccuse {room.name}? [Y/n] ").casefold().strip()
			if inp not in ["n", "no"]:
				break

		if (accused_suspect, accused_weapon, accused_room) == game.solution:
			print(f"{player.name} wins!")
			break
		else:
			player.failed_guess = True

def main():
	n_human: int | None = None
	while True:
		try:
			response = int(input("How many players will be human? ").strip())
		except ValueError:
			print("Please enter a number.")
			continue
		if response > 6:
			print("Human player count cannot exceed total player count.")
			continue
		if response < 1:
			print("At least one human player is required.")
			continue
		n_human = response
		continue
	print()
	assert n_human is not None, "Make ty happy?"

	n_robot = 6 - n_human
	remaining_suspects = [suspect for suspect in Suspect]

	humans = _create_human_players(n_human, remaining_suspects)
	robots = _create_robot_players(n_robot, remaining_suspects)

	all_players = humans + robots
	all_players.sort(key=lambda x: x.index)
	_confirm_turn_order(all_players)

	game = Game(all_players)
	game.begin()
	_play_game(game)

if __name__ == "__main__":
	main()
