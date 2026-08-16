from __future__ import annotations
from enum import StrEnum
from dataclasses import dataclass, field
from typing import Literal

import random

from rapidfuzz import fuzz


class Suspect(StrEnum):
	MISS_SCARLETT = "Miss Scarlett"
	PROFESSOR_PLUM = "Professor Plum"
	MRS_PEACOCK = "Mrs. Peacock"
	COLONEL_MUSTARD = "Colonel Mustard"
	MR_GREEN = "Mr. Green"
	MRS_WHITE = "Mrs. White"


STARTING_POSITIONS = {  # board is 24 in width, 25 in height
	Suspect.MISS_SCARLETT: (16, 24),
	Suspect.PROFESSOR_PLUM: (0, 19),
	Suspect.MRS_PEACOCK: (0, 6),
	Suspect.COLONEL_MUSTARD: (23, 17),
	Suspect.MR_GREEN: (9, 0),
	Suspect.MRS_WHITE: (14, 0),
}


class Weapon(StrEnum):
	CANDLESTICK = "Candlestick"
	DAGGER = "Dagger"
	LEAD_PIPE = "Lead Pipe"
	REVOLVER = "Revolver"
	ROPE = "Rope"
	WRENCH = "Wrench"


class Room(StrEnum):
	BALLROOM = "Ballroom"
	BILLIARD_ROOM = "Billiard Room"
	CONSERVATORY = "Conservatory"
	DINING_ROOM = "Dining Room"
	HALL = "Hall"
	KITCHEN = "Kitchen"
	LIBRARY = "Library"
	LOUNGE = "Lounge"
	STUDY = "Study"


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


@dataclass(eq=False)
class BoardSpace:
	room: Room | None = None
	accesses: list[BoardSpace] = field(default_factory=list)
	pos: tuple[int, int] | None = None

	def __hash__(self):
		if self.room:
			return hash(self.room.name)
		if self.pos:
			return hash(self.pos)
		raise ValueError("room and pos can't both be None")


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
	cards: list[Card] = field(default_factory=list)
	is_robot: bool = False
	guessed_here: bool = False
	moved_by_suggestion: bool = False


DEFAULT_SUSPECTS = [suspect for suspect in Suspect]
DEFAULT_WEAPONS = [weapon for weapon in Weapon]
DEFAULT_ROOMS = [room for room in Room]


class Game:
	def __init__(self) -> None:
		self.players: list[Player] = []
		self.solution: tuple[SuspectCard, WeaponCard, RoomCard] | None = None

		ballroom = BoardSpace(room=Room.BALLROOM)
		billiard_room = BoardSpace(room=Room.BILLIARD_ROOM)
		conservatory = BoardSpace(room=Room.CONSERVATORY)
		dining_room = BoardSpace(room=Room.DINING_ROOM)
		hall = BoardSpace(room=Room.HALL)
		kitchen = BoardSpace(room=Room.KITCHEN)
		library = BoardSpace(room=Room.LIBRARY)
		lounge = BoardSpace(room=Room.LOUNGE)
		study = BoardSpace(room=Room.STUDY)

		self.board: list[list[BoardSpace | None]] = [[None] * 25 for _ in range(24)]
		for col in range(24):
			for row in range(25):
				match (col, row):
					case (x, y) if (10 <= x <= 13 and y == 1) or (
						8 <= x <= 15 and 2 <= y <= 7
					):
						self.board[x][y] = ballroom
					case (x, y) if x <= 5 and 8 <= y <= 12:
						self.board[x][y] = billiard_room
					case (x, y) if (x <= 5 and 1 <= y <= 4) or (1 <= x <= 4 and y == 5):
						self.board[x][y] = conservatory
					case (x, y) if (19 <= x <= 23 and y == 9) or (
						16 <= x <= 23 and 10 <= y <= 15
					):
						self.board[x][y] = dining_room
					case (x, y) if 9 <= x <= 14 and 18 <= y <= 23:
						self.board[x][y] = hall
					case (x, y) if (18 <= x <= 23 and y <= 5) or (
						18 <= x <= 22 and y == 6
					):
						self.board[x][y] = kitchen
					case (x, y) if (1 <= x <= 5 and y in [14, 18]) or (
						x <= 6 and 15 <= y <= 17
					):
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
			self._space(7, 5),
			self._space(9, 8),
			self._space(14, 8),
			self._space(16, 5),
		]
		billiard_room.accesses = [self._space(6, 9), self._space(1, 13)]
		conservatory.accesses = [lounge, self._space(5, 5)]
		dining_room.accesses = [self._space(15, 12), self._space(16, 16)]
		hall.accesses = [self._space(11, 17), self._space(12, 17), self._space(8, 20)]
		kitchen.accesses = [study, self._space(19, 7)]
		library.accesses = [self._space(3, 13), self._space(7, 16)]
		lounge.accesses = [conservatory, self._space(17, 18)]
		study.accesses = [kitchen, self._space(6, 20)]

		for col in self.board:
			for space in col:
				if space is None:
					continue
				if space.room or space.accesses or space.pos is None:
					continue
				col_, row_ = space.pos
				for x in [col_ - 1, col_, col_ + 1]:
					for y in [row_ - 1, row_, row_ + 1]:
						if x < 0 or x > 23 or y < 0 or y > 24:
							continue
						if (x, y) == space.pos:
							continue
						if x != col_ and y != row_:
							continue
						accessee = self.board[x][y]
						if accessee is None:
							continue
						if accessee.room and space not in accessee.accesses:
							continue
						space.accesses.append(accessee)

	def _space(self, x: int, y: int) -> BoardSpace:
		space = self.board[x][y]
		assert space is not None
		return space

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
			i = (i + 1) % len(self.players)


def _create_human_players(n: int, suspects: list[Suspect], game: Game) -> list[Player]:
	players: list[Player] = []

	for i in range(n):
		name = input(f"What is player {i + 1}'s name? ").strip()

		suspect: Suspect | None = None
		while True:
			print(f"Which suspect would player {i + 1} like to play?")
			for j, sus in enumerate(suspects):
				print(f"[{j + 1}]\t{sus.value}")
			inp = input("> ").casefold().strip()

			try:
				idx = int(inp)
				suspect = suspects[idx - 1]
			except (ValueError, IndexError):
				suspect = max(
					suspects, key=lambda x: fuzz.ratio(inp, x.value.casefold())
				)

			confirmation = (
				input(f"Selected {suspect.value}. Correct? [Y/n] ").casefold().strip()
			)
			if confirmation not in ["n", "no"]:
				break
		suspects.remove(suspect)
		print()

		players.append(
			Player(
				index=0,
				name=name,
				failed_guess=False,
				piece=SuspectPiece(
					suspect=suspect, location=game._space(*STARTING_POSITIONS[suspect])
				),
				cards=[],
				is_robot=False,
			)
		)

	return players


def _create_robot_players(n: int, suspects: list[Suspect], game: Game) -> list[Player]:
	players: list[Player] = []

	for i in range(n):
		suspect = suspects[i]
		players.append(
			Player(
				index=0,
				name=suspect.value,
				failed_guess=False,
				piece=SuspectPiece(
					suspect=suspect, location=game._space(*STARTING_POSITIONS[suspect])
				),
				cards=[],
				is_robot=True,
			)
		)

	return players


def _confirm_turn_order(players: list[Player]) -> None:
	players.sort(key=lambda x: x.index)

	while True:
		print("Turn order will be as follows (skips in numbers allowed):")
		for i, player in enumerate(players):
			print(f"[{i + 1}]\t{player.name}")
		confirmation = input("Change? [y/N] ").casefold().strip()
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
	piece: SuspectPiece, board: list[list[BoardSpace | None]], limit: int
) -> tuple[list[BoardSpace], list[int]]:
	if limit <= 0:
		return ([], [])

	source = piece.location

	space_queue: list[tuple[BoardSpace, int]] = []  # space : cost
	visited: dict[BoardSpace, int] = {}  # space : cost

	for space in source.accesses:
		# secret passages are a start-of-turn alternative to rolling, not a dice move
		if source.room and space.room:
			continue
		# a door is not a space: stepping through it into a room is free
		if space.room:
			space_queue.append((space, 0))
		else:
			space_queue.append((space, 1))

	while space_queue:
		space, cost = space_queue.pop(0)
		if space == source:
			continue
		if cost > limit:
			continue
		existing = visited.get(space)
		if existing is not None and cost >= existing:
			continue
		visited[space] = cost
		# entering a room ends the move: rooms are destinations only, so only
		# corridors are expanded (no pass-through, no secret-passage chaining)
		if not space.room:
			for accessee in space.accesses:
				if accessee.room:
					space_queue.append((accessee, cost))  # through the door (free)
				else:
					space_queue.append((accessee, cost + 1))  # along the corridor

	items = sorted(visited.items(), key=lambda x: x[1])
	return ([k for k, _ in items], [v for _, v in items])


def _play_game(game: Game) -> None:
	turn_idx = 0
	while True:
		if all(p.failed_guess for p in game.players):
			print("All players have failed to solve the mystery. Game over.")
			break
		player = game.players[turn_idx]
		turn_idx = (turn_idx + 1) % len(game.players)
		if player.failed_guess:
			continue
		print(f"Beginning {player.name}'s turn...")
		player.guessed_here = False
		can_guess_without_move = player.moved_by_suggestion
		player.moved_by_suggestion = False

		if not player.is_robot:
			print(f"\t{player.name} cards in hand:")
			for card in player.cards:
				print(f"\t- {card}")

		# secret passage: a start-of-turn alternative to rolling, from a corner room
		entered_room = False
		secret_room: Room | None = None
		secret_target: BoardSpace | None = None
		if player.piece.location.room is not None:
			for a in player.piece.location.accesses:
				if a.room is not None:
					secret_target = a
					secret_room = a.room
					break
		used_secret = False
		if secret_target is not None and secret_room is not None:
			if player.is_robot:
				used_secret = random.choice([True, False])
			else:
				used_secret = input(
					f"\tUse the secret passage to {secret_room.value}? [Y/n] "
				).casefold().strip() not in ["n", "no"]
			if used_secret:
				player.piece.location = secret_target
				entered_room = True
				print(
					f"\t{player.name} took the secret passage to {secret_room.value}."
				)

		# do we want to roll the dice?
		if not used_secret:
			if player.is_robot:
				dice_conf = True
			else:
				dice_conf = input(
					"\tRoll dice to move? [Y/n] "
				).casefold().strip() not in ["n", "no"]
		else:
			dice_conf = False

		# dice rolling
		if dice_conf:
			die_result = random.randint(1, 6) + random.randint(1, 6)
			print(f"\tDie result: {die_result}")
			dests, costs = _pathfind(player.piece, game.board, die_result)
			destination: BoardSpace | None = None
			if (
				player.is_robot
			):  # computers choose the farthest room (or farthest space)
				destination = max(
					zip(dests, costs), key=lambda x: x[1] + 100 if x[0].room else x[1]
				)[0]
				dst_str = (
					destination.room.value if destination.room else str(destination.pos)
				)
				print(f"\t{player.name} went to space {dst_str}.")
			elif any([space.room for space in dests]):  # only show rooms for brevity
				rooms = [dest for dest in dests if dest.room]
				while True:
					print("\tChoose a room to go to:")
					n_options = 1
					for i, space in enumerate(rooms):
						assert space.room is not None
						print(f"\t[{i + 1}]\t{space.room.value}")
						n_options += 1
					print(f"\t[{n_options}]\t(Stay put)")
					inp = input("> ").casefold().strip()
					try:
						idx = int(inp)
						if idx == n_options:
							destination = player.piece.location
						else:
							destination = rooms[idx - 1]
					except (ValueError, IndexError):
						destination = max(
							rooms,
							key=lambda x: fuzz.ratio(inp, x.room.value.casefold()),
						)
						assert destination.room is not None
						if fuzz.ratio(inp, "stay put") > fuzz.ratio(
							inp, destination.room.value.casefold()
						):
							destination = player.piece.location
					inp = "n"
					if destination == player.piece.location:
						inp = input("\tStay put? [Y/n] ").casefold().strip()
					else:
						dst_str = (
							destination.room.value
							if destination.room
							else str(destination.pos)
						)
						inp = input(f"\tGo to {dst_str}? [Y/n] ").casefold().strip()
					if inp not in ["n", "no"]:
						break
			else:  # show all spaces if no room is reachable
				while True:
					print("\tChoose a space to go to:")
					n_options = 1
					for i, space in enumerate(dests):
						print(f"\t[{i + 1}]\t{space.pos}")
						n_options += 1
					print(f"\t[{n_options}]\t(Stay put)")
					inp = input("> ").casefold().strip()
					try:
						idx = int(inp)
						if idx == n_options:
							destination = player.piece.location
						else:
							destination = dests[idx - 1]
					except (ValueError, IndexError):
						continue
					dest_conf = "n"
					if destination == player.piece.location:
						dest_conf = input("\tStay put? [Y/n] ").casefold().strip()
					else:
						dst_str = (
							destination.room.value
							if destination.room
							else str(destination.pos)
						)
						dest_conf = (
							input(f"\tGo to {dst_str}? [Y/n] ").casefold().strip()
						)
					if dest_conf not in ["n", "no"]:
						break
			if destination is not None and destination != player.piece.location:
				player.piece.location = destination
				if destination.room is not None:
					entered_room = True
			if destination.room is None:
				continue
			print()

		# guess time
		guess: tuple[Suspect, Weapon, Room] | None = None
		if player.is_robot:
			guess_conf = (
				entered_room or can_guess_without_move
			) and not player.guessed_here
		else:
			guess_conf = (
				(entered_room or can_guess_without_move)
				and not player.guessed_here
				and input("\tMake a guess now? [Y/n] ").casefold().strip()
				not in ["n", "no"]
			)
		if guess_conf:
			assert player.piece.location.room is not None
			if player.is_robot:
				guess = (
					random.choice([suspect for suspect in Suspect]),
					random.choice([weapon for weapon in Weapon]),
					player.piece.location.room,
				)
			else:
				print("\tSelect a suspect to guess:")
				for i, suspect in enumerate(Suspect):
					print(f"\t[{i + 1}]\t{suspect.value}")
				guess_suspect: Suspect | None = None  # finalized guess
				while True:
					inp = input("> ")
					try:
						idx = int(inp)
						guess_suspect = [suspect for suspect in Suspect][idx - 1]
					except (ValueError, IndexError):
						guess_suspect = max(
							[suspect for suspect in Suspect],
							key=lambda x: fuzz.ratio(inp, x.value),
						)
					inp = (
						input(f"\tGuess {guess_suspect.value}? [Y/n] ")
						.casefold()
						.strip()
					)
					if inp not in ["n", "no"]:
						break
				print(f"\tGuessing {guess_suspect.value}...")
				print()

				print("\tSelect a murder weapon to guess:")
				for i, weapon in enumerate(Weapon):
					print(f"\t[{i + 1}]\t{weapon.value}")
				guess_weapon: Weapon | None = None  # finalized guess
				while True:
					inp = input("> ")
					try:
						idx = int(inp)
						guess_weapon = [weapon for weapon in Weapon][idx - 1]
					except (ValueError, IndexError):
						guess_weapon = max(
							[weapon for weapon in Weapon],
							key=lambda x: fuzz.ratio(inp, x.value),
						)
					inp = (
						input(f"\tGuess {guess_weapon.value}? [Y/n] ")
						.casefold()
						.strip()
					)
					if inp not in ["n", "no"]:
						break
				guess = guess_suspect, guess_weapon, player.piece.location.room
			assert guess is not None
			print(
				f"\tGuessing {guess[0].value} with {guess[1].value} in {guess[2].value}."
			)
			print()
			player.guessed_here = True
			# a suggestion moves the named suspect's piece into this room;
			# if it belongs to another player, they may guess next turn without moving
			for p in game.players:
				if p.piece.suspect == guess[0] and p is not player:
					p.piece.location = player.piece.location
					p.moved_by_suggestion = True
					break

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
					card
					for card in other.cards
					if (card.type == "suspect" and card.suspect == guess[0])
					or (card.type == "weapon" and card.weapon == guess[1])
					or (card.type == "room" and card.room == guess[2])
				]
				if not matching_cards:
					continue
				shown_card: Card | None = None  # finalized card to show
				if other.is_robot:
					shown_card = random.choice(matching_cards)
				else:
					while True:
						inp = input(f"\tChoose a card to show to {player.name}:")
						names = [
							card.suspect.value
							if card.type == "suspect"
							else card.weapon.value
							if card.type == "weapon"
							else card.room.value
							for card in matching_cards
						]
						for i, name in enumerate(names):
							print(f"\t[{i + 1}]\t{name}")
						inp = input("> ").casefold().strip()
						try:
							idx = int(inp)
							shown_card = matching_cards[idx - 1]
						except (ValueError, IndexError):
							shown_card = max(
								zip(matching_cards, names),
								key=lambda x: fuzz.ratio(inp, x[1]),
							)[0]
						name = names[matching_cards.index(shown_card)]
						inp = input(f"\tShow {name}? [Y/n] ")
						if inp not in ["n", "no"]:
							break
				shown_name = (
					shown_card.suspect.value
					if shown_card.type == "suspect"
					else shown_card.weapon.value
					if shown_card.type == "weapon"
					else shown_card.room.value
				)
				if player.is_robot:
					print(f"\t{other.name} showed a card to {player.name}.")
				else:
					print(f"\t{other.name} showed you: {shown_name}.")
				break
		print()

		if player.is_robot:
			continue
		inp = input("\tMake an accusation now? [y/N] ").casefold().strip()
		if inp not in ["y", "ye", "yes"]:
			continue

		accused_suspect: Suspect | None = None  # finalized accusation
		print("\tChoose a suspect to accuse:")
		for i, suspect in enumerate(Suspect):
			print(f"\t[{i + 1}]\t{suspect.value}")
		while True:
			inp = input("> ").casefold().strip()
			try:
				idx = int(inp)
				accused_suspect = [suspect for suspect in Suspect][idx - 1]
			except (ValueError, IndexError):
				accused_suspect = max(
					[suspect for suspect in Suspect],
					key=lambda x: fuzz.ratio(inp, x.value),
				)
			inp = input(f"\tAccuse {accused_suspect.value}? [Y/n] ").casefold().strip()
			if inp not in ["n", "no"]:
				break

		accused_weapon: Weapon | None = None
		print("\tChoose a weapon to accuse:")
		for i, weapon in enumerate(Weapon):
			print(f"\t[{i + 1}]\t{weapon.value}")
		while True:
			inp = input("> ").casefold().strip()
			try:
				idx = int(inp)
				accused_weapon = [weapon for weapon in Weapon][idx - 1]
			except (ValueError, IndexError):
				accused_weapon = max(
					[weapon for weapon in Weapon],
					key=lambda x: fuzz.ratio(inp, x.value),
				)
			inp = input(f"\tAccuse {accused_weapon.value}? [Y/n] ").casefold().strip()
			if inp not in ["n", "no"]:
				break

		accused_room: Room | None = None
		print("\tChoose a room to accuse:")
		for i, room in enumerate(Room):
			print(f"\t[{i + 1}]\t{room.value}")
		while True:
			inp = input("> ").casefold().strip()
			try:
				idx = int(inp)
				accused_room = [room for room in Room][idx - 1]
			except (ValueError, IndexError):
				accused_room = max(
					[room for room in Room], key=lambda x: fuzz.ratio(inp, x.value)
				)
			inp = input(f"\tAccuse {accused_room.value}? [Y/n] ").casefold().strip()
			if inp not in ["n", "no"]:
				break

		assert game.solution is not None
		if (
			accused_suspect == game.solution[0].suspect
			and accused_weapon == game.solution[1].weapon
			and accused_room == game.solution[2].room
		):
			print(f"{player.name} wins!")
			break
		else:
			print("Incorrect.")
			player.failed_guess = True
			if all([player.is_robot or player.failed_guess for player in game.players]):
				print("Game over. All human players lost.")
				print(f"The solution was {game.solution}")
				break


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
		break
	print()
	assert n_human is not None, "Make ty happy?"

	n_robot = 6 - n_human
	remaining_suspects = [suspect for suspect in Suspect]

	game = Game()

	humans = _create_human_players(n_human, remaining_suspects, game)
	robots = _create_robot_players(n_robot, remaining_suspects, game)

	all_players = humans + robots
	all_players.sort(key=lambda x: x.index)
	_confirm_turn_order(all_players)

	game.players = all_players
	game.begin()
	_play_game(game)


if __name__ == "__main__":
	main()
