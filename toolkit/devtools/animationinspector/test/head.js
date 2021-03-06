/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* Any copyright is dedicated to the Public Domain.
 http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const Cu = Components.utils;
const {gDevTools} = Cu.import("resource://gre/modules/devtools/gDevTools.jsm", {});
const {devtools} = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
const {Promise: promise} = Cu.import("resource://gre/modules/Promise.jsm", {});
const TargetFactory = devtools.TargetFactory;
const {console} = Components.utils.import("resource://gre/modules/devtools/Console.jsm", {});
const {ViewHelpers} = Cu.import("resource://gre/modules/devtools/ViewHelpers.jsm", {});

// All tests are asynchronous
waitForExplicitFinish();

const TEST_URL_ROOT = "http://example.com/browser/browser/devtools/animationinspector/test/";
const ROOT_TEST_DIR = getRootDirectory(gTestPath);
const FRAME_SCRIPT_URL = ROOT_TEST_DIR + "doc_frame_script.js";
const COMMON_FRAME_SCRIPT_URL = "chrome://global/content/devtools/frame-script-utils.js";

// Auto clean-up when a test ends
registerCleanupFunction(function*() {
  let target = TargetFactory.forTab(gBrowser.selectedTab);
  yield gDevTools.closeToolbox(target);

  while (gBrowser.tabs.length > 1) {
    gBrowser.removeCurrentTab();
  }
});

// Uncomment this pref to dump all devtools emitted events to the console.
// Services.prefs.setBoolPref("devtools.dump.emit", true);

// Uncomment this pref to dump all devtools protocol traffic
// Services.prefs.setBoolPref("devtools.debugger.log", true);

// Set the testing flag on gDevTools and reset it when the test ends
gDevTools.testing = true;
registerCleanupFunction(() => gDevTools.testing = false);

// Clean-up all prefs that might have been changed during a test run
// (safer here because if the test fails, then the pref is never reverted)
registerCleanupFunction(() => {
  Services.prefs.clearUserPref("devtools.dump.emit");
  Services.prefs.clearUserPref("devtools.debugger.log");
});

/**
 * Add a new test tab in the browser and load the given url.
 * @param {String} url The url to be loaded in the new tab
 * @return a promise that resolves to the tab object when the url is loaded
 */
function addTab(url) {
  info("Adding a new tab with URL: '" + url + "'");
  let def = promise.defer();

  window.focus();

  let tab = window.gBrowser.selectedTab = window.gBrowser.addTab(url);
  let browser = tab.linkedBrowser;

  info("Loading the helper frame script " + FRAME_SCRIPT_URL);
  browser.messageManager.loadFrameScript(FRAME_SCRIPT_URL, false);

  info("Loading the helper frame script " + COMMON_FRAME_SCRIPT_URL);
  browser.messageManager.loadFrameScript(COMMON_FRAME_SCRIPT_URL, false);

  browser.addEventListener("load", function onload() {
    browser.removeEventListener("load", onload, true);
    info("URL '" + url + "' loading complete");

    def.resolve(tab);
  }, true);

  return def.promise;
}

/**
 * Reload the current tab location.
 */
function reloadTab() {
  return executeInContent("devtools:test:reload", {}, {}, false);
}

/**
 * Get the NodeFront for a given css selector, via the protocol
 * @param {String} selector
 * @param {InspectorPanel} inspector The instance of InspectorPanel currently
 * loaded in the toolbox
 * @return {Promise} Resolves to the NodeFront instance
 */
function getNodeFront(selector, {walker}) {
  return walker.querySelector(walker.rootNode, selector);
}

/*
 * Set the inspector's current selection to a node or to the first match of the
 * given css selector.
 * @param {String|NodeFront}
 *        data The node to select
 * @param {InspectorPanel} inspector
 *        The instance of InspectorPanel currently
 * loaded in the toolbox
 * @param {String} reason
 *        Defaults to "test" which instructs the inspector not
 *        to highlight the node upon selection
 * @return {Promise} Resolves when the inspector is updated with the new node
 */
let selectNode = Task.async(function*(data, inspector, reason="test") {
  info("Selecting the node for '" + data + "'");
  let nodeFront = data;
  if (!data._form) {
    nodeFront = yield getNodeFront(data, inspector);
  }
  let updated = inspector.once("inspector-updated");
  inspector.selection.setNodeFront(nodeFront, reason);
  yield updated;
});

/**
 * Open the toolbox, with the inspector tool visible and the animationinspector
 * sidebar selected.
 * @return a promise that resolves when the inspector is ready
 */
let openAnimationInspector = Task.async(function*() {
  let target = TargetFactory.forTab(gBrowser.selectedTab);

  info("Opening the toolbox with the inspector selected");
  let toolbox = yield gDevTools.showToolbox(target, "inspector");
  yield waitForToolboxFrameFocus(toolbox);

  info("Switching to the animationinspector");
  let inspector = toolbox.getPanel("inspector");
  let initPromises = [
    inspector.once("inspector-updated"),
    inspector.sidebar.once("animationinspector-ready")
  ];
  inspector.sidebar.select("animationinspector");

  info("Waiting for the inspector and sidebar to be ready");
  yield promise.all(initPromises);

  let win = inspector.sidebar.getWindowForTab("animationinspector");
  let {AnimationsController, AnimationsPanel} = win;

  info("Waiting for the animation controller and panel to be ready");
  if (AnimationsPanel.initialized) {
    yield AnimationsPanel.initialized;
  } else {
    yield AnimationsPanel.once(AnimationsPanel.PANEL_INITIALIZED);
  }

  return {
    toolbox: toolbox,
    inspector: inspector,
    controller: AnimationsController,
    panel: AnimationsPanel,
    window: win
  };
});

/**
 * Wait for the toolbox frame to receive focus after it loads
 * @param {Toolbox} toolbox
 * @return a promise that resolves when focus has been received
 */
function waitForToolboxFrameFocus(toolbox) {
  info("Making sure that the toolbox's frame is focused");
  let def = promise.defer();
  let win = toolbox.frame.contentWindow;
  waitForFocus(def.resolve, win);
  return def.promise;
}

/**
 * Checks whether the inspector's sidebar corresponding to the given id already
 * exists
 * @param {InspectorPanel}
 * @param {String}
 * @return {Boolean}
 */
function hasSideBarTab(inspector, id) {
  return !!inspector.sidebar.getWindowForTab(id);
}

/**
 * Wait for eventName on target.
 * @param {Object} target An observable object that either supports on/off or
 * addEventListener/removeEventListener
 * @param {String} eventName
 * @param {Boolean} useCapture Optional, for addEventListener/removeEventListener
 * @return A promise that resolves when the event has been handled
 */
function once(target, eventName, useCapture=false) {
  info("Waiting for event: '" + eventName + "' on " + target + ".");

  let deferred = promise.defer();

  for (let [add, remove] of [
    ["addEventListener", "removeEventListener"],
    ["addListener", "removeListener"],
    ["on", "off"]
  ]) {
    if ((add in target) && (remove in target)) {
      target[add](eventName, function onEvent(...aArgs) {
        target[remove](eventName, onEvent, useCapture);
        deferred.resolve.apply(deferred, aArgs);
      }, useCapture);
      break;
    }
  }

  return deferred.promise;
}

/**
 * Wait for a content -> chrome message on the message manager (the window
 * messagemanager is used).
 * @param {String} name The message name
 * @return {Promise} A promise that resolves to the response data when the
 * message has been received
 */
function waitForContentMessage(name) {
  info("Expecting message " + name + " from content");

  let mm = gBrowser.selectedBrowser.messageManager;

  let def = promise.defer();
  mm.addMessageListener(name, function onMessage(msg) {
    mm.removeMessageListener(name, onMessage);
    def.resolve(msg.data);
  });
  return def.promise;
}

/**
 * Send an async message to the frame script (chrome -> content) and wait for a
 * response message with the same name (content -> chrome).
 * @param {String} name The message name. Should be one of the messages defined
 * in doc_frame_script.js
 * @param {Object} data Optional data to send along
 * @param {Object} objects Optional CPOW objects to send along
 * @param {Boolean} expectResponse If set to false, don't wait for a response
 * with the same name from the content script. Defaults to true.
 * @return {Promise} Resolves to the response data if a response is expected,
 * immediately resolves otherwise
 */
function executeInContent(name, data={}, objects={}, expectResponse=true) {
  info("Sending message " + name + " to content");
  let mm = gBrowser.selectedBrowser.messageManager;

  mm.sendAsyncMessage(name, data, objects);
  if (expectResponse) {
    return waitForContentMessage(name);
  } else {
    return promise.resolve();
  }
}

function onceNextPlayerRefresh(player) {
  let onRefresh = promise.defer();
  player.once(player.AUTO_REFRESH_EVENT, onRefresh.resolve);
  return onRefresh.promise;
}

/**
 * Simulate a click on the playPause button of a playerWidget.
 */
let togglePlayPauseButton = Task.async(function*(widget) {
  let nextState = widget.player.state.playState === "running" ? "paused" : "running";

  // Note that instead of simulating a real event here, the callback is just
  // called. This is better because the callback returns a promise, so we know
  // when the player is paused, and we don't really care to test that simulating
  // a DOM event actually works.
  let onClicked = widget.onPlayPauseBtnClick();

  // Verify that the button's state is changed immediately, even if it will be
  // changed anyway with the next auto-refresh.
  ok(widget.el.classList.contains(nextState),
    "The button's state was changed in the UI before the request was sent");

  yield onClicked;

  // Wait until the state changes.
  yield waitForPlayState(widget.player, nextState);
});

/**
 * Wait for a player's auto-refresh events and stop when a condition becomes
 * truthy.
 * @param {AnimationPlayerFront} player
 * @param {Function} conditionCheck Will be called over and over again when the
 * player state changes, passing the state as argument. This method must return
 * a truthy value to stop waiting.
 * @param {String} desc If provided, this will be logged with info(...) every
 * time the state is refreshed, until the condition passes.
 * @return {Promise} Resolves when the condition passes.
 */
let waitForStateCondition = Task.async(function*(player, conditionCheck, desc="") {
  if (desc) {
    desc = "(" + desc + ")";
  }
  info("Waiting for a player's auto-refresh event " + desc);
  let def = promise.defer();
  player.on(player.AUTO_REFRESH_EVENT, function onNewState() {
    info("State refreshed, checking condition ... " + desc);
    if (conditionCheck(player.state)) {
      player.off(player.AUTO_REFRESH_EVENT, onNewState);
      def.resolve();
    }
  });
  return def.promise;
});

/**
 * Wait for a player's auto-refresh events and stop when the playState is the
 * provided string.
 * @param {AnimationPlayerFront} player
 * @param {String} playState The playState to expect.
 * @return {Promise} Resolves when the playState has changed to the expected value.
 */
function waitForPlayState(player, playState) {
  return waitForStateCondition(player, state => {
    return state.playState === playState;
  }, "Waiting for animation to be " + playState);
}

/**
 * Wait for the player's auto-refresh events until the animation is paused.
 * When done, check its currentTime.
 * @param {PlayerWidget} widget.
 * @param {Numer} time.
 * @return {Promise} Resolves when the animation is paused and tests have ran.
 */
let checkPausedAt = Task.async(function*(widget, time) {
  info("Wait for the next auto-refresh");

  yield waitForStateCondition(widget.player, state => {
    return state.playState === "paused" && state.currentTime === time;
  }, "Waiting for animation to pause at " + time + "ms");

  ok(widget.el.classList.contains("paused"), "The widget is in paused mode");
  is(widget.player.state.currentTime, time,
    "The player front's currentTime was set to " + time);
  is(widget.currentTimeEl.value, time, "The input's value was set to " + time);
});

/**
 * Get the current playState of an animation player on a given node.
 */
let getAnimationPlayerState = Task.async(function*(selector, animationIndex=0) {
  let playState = yield executeInContent("Test:GetAnimationPlayerState",
                                         {selector, animationIndex});
  return playState;
});

/**
 * Is the given node visible in the page (rendered in the frame tree).
 * @param {DOMNode}
 * @return {Boolean}
 */
function isNodeVisible(node) {
  return !!node.getClientRects().length;
}
