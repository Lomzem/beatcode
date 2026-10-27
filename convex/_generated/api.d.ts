/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as calibration from "../calibration.js";
import type * as calibrationState from "../calibrationState.js";
import type * as cards from "../cards.js";
import type * as clock from "../clock.js";
import type * as crons from "../crons.js";
import type * as decks from "../decks.js";
import type * as game_access from "../game/access.js";
import type * as game_binding from "../game/binding.js";
import type * as game_cards from "../game/cards.js";
import type * as game_catalog from "../game/catalog.js";
import type * as game_effect from "../game/effect.js";
import type * as game_judging from "../game/judging.js";
import type * as game_retention from "../game/retention.js";
import type * as game_rounds from "../game/rounds.js";
import type * as game_state from "../game/state.js";
import type * as game_timing from "../game/timing.js";
import type * as game_tokens from "../game/tokens.js";
import type * as game_usage from "../game/usage.js";
import type * as game_validators from "../game/validators.js";
import type * as game_views from "../game/views.js";
import type * as judge from "../judge.js";
import type * as judgeController from "../judgeController.js";
import type * as judgeDispatch from "../judgeDispatch.js";
import type * as judgeSession from "../judgeSession.js";
import type * as matches from "../matches.js";
import type * as ops from "../ops.js";
import type * as players from "../players.js";
import type * as presence from "../presence.js";
import type * as problems from "../problems.js";
import type * as rooms from "../rooms.js";
import type * as rounds from "../rounds.js";
import type * as samples from "../samples.js";
import type * as submissions from "../submissions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  calibration: typeof calibration;
  calibrationState: typeof calibrationState;
  cards: typeof cards;
  clock: typeof clock;
  crons: typeof crons;
  decks: typeof decks;
  "game/access": typeof game_access;
  "game/binding": typeof game_binding;
  "game/cards": typeof game_cards;
  "game/catalog": typeof game_catalog;
  "game/effect": typeof game_effect;
  "game/judging": typeof game_judging;
  "game/retention": typeof game_retention;
  "game/rounds": typeof game_rounds;
  "game/state": typeof game_state;
  "game/timing": typeof game_timing;
  "game/tokens": typeof game_tokens;
  "game/usage": typeof game_usage;
  "game/validators": typeof game_validators;
  "game/views": typeof game_views;
  judge: typeof judge;
  judgeController: typeof judgeController;
  judgeDispatch: typeof judgeDispatch;
  judgeSession: typeof judgeSession;
  matches: typeof matches;
  ops: typeof ops;
  players: typeof players;
  presence: typeof presence;
  problems: typeof problems;
  rooms: typeof rooms;
  rounds: typeof rounds;
  samples: typeof samples;
  submissions: typeof submissions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
