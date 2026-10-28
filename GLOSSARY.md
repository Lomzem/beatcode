# Beatcode

Private competitive programming matches with cards that hinder an opponent.

## Language

**Room**:
A private lobby where a host and one guest choose decks, get ready and play one or more matches against each other.
_Avoid_: Lobby, game

**Host**:
The signed-in player who creates a room. Any signed-in player may host.

**Guest**:
The second player, admitted to a room by its invitation.
_Avoid_: Opponent (when meaning the room role)

**Invitation**:
The private link, or its equivalent short room code, that a host shares to admit one guest to their room. It stops admitting once a guest joins or it expires; the host may replace it.
_Avoid_: Invite

**Match**:
A private contest between two players consisting of up to three sequential rounds. Two round wins end it early; otherwise the player with more round wins after three rounds wins, with equal wins producing a draw.

**Round**:
A timed race in which both players solve the same problem. The earliest server-admitted submission that is ultimately accepted wins; a round without an accepted submission is a draw.

**Submission**:
A player's proposed C++ solution sent for competitive judging.

**Accepted submission**:
A submission that passes every hidden test within the problem's execution limits and satisfies the applicable competitive restrictions.

**Card**:
A playable effect that hinders an opponent and has a power cost.

**Deck**:
The cards a player selects for a match from the shared, fully unlocked card pool.

**Power**:
The resource a player spends to play cards.
