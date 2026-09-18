import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
/**
 * The `/dcp` session panel screens, rendered into the host's
 * `session.panel` slot.
 *
 * Reads live data reactively from the `@opencode/plugin/tui` `Context`:
 *   - `data.session.get(id)`      → current session (tokens, title, model)
 *   - `data.location.model.list()`→ model catalog (context limit)
 *   - `client.session.context(id)`→ durable messages (for the context breakdown)
 *
 * The core's durable docs (session state + all-time) come through the
 * `bridge` module: the panel opens the host DB read-only (`bun:sqlite`) and
 * reads the same `kv` rows the core plugin writes, polling while the panel
 * is open. The manual-mode toggle writes a mirror file the core re-reads on
 * every context hook, so the panel and the pipeline always agree.
 */
import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "opentui:runtime-module:solid-js";
import { TextAttributes } from "opentui:runtime-module:%40opentui%2Fcore";
import { toWithParts } from "../../src/lib/compress/durable.ts";
import { analyzeContextTokens } from "../../src/lib/commands/context.ts";
import { buildSessionStatsSummary } from "../../src/lib/commands/stats.ts";
import { ALL_TIME_KEY } from "../../src/lib/state/persistence.ts";
import { DCP_PLUGIN_ID, loadKvDoc, writeManualMirror } from "../../src/lib/tui/bridge.ts";
import { formatDuration, formatRatio, formatTokenCount, pct } from "../../src/lib/ui/utils.ts";
import { PANEL_NAME, allTimeStats, buildPanelState, currentUsageTokens, emptyPanelDoc, modelContextLimit, zeroAllTime } from "../../src/lib/tui/data.ts";

/**
 * Structural subset of the resolved theme. The host's `ResolvedTheme`
 * (`@opencode/theme/tui`) is not installed here, so this is cast
 * defensively; any missing token falls back to the host default color.
 */

/** The host TUI context, derived from the public `usePlugin` API. */

/** Structural subset of the host's `session.panel` slot input (PanelInput). */

const themeOf = context => context.theme;

/**
 * Slot entry point: only render the DCP panel while the host is showing the
 * panel this plugin registered. The store/resource bindings key off the
 * `sessionID` prop, which is stable per slot render.
 */
export function DcpPanelHost(props) {
  return _$createComponent(Show, {
    get when() {
      return props.panel.name === PANEL_NAME;
    },
    get children() {
      return _$createComponent(DcpPanel, {
        get context() {
          return props.context;
        },
        get sessionID() {
          return props.panel.sessionID;
        },
        get config() {
          return props.config;
        },
        get onClose() {
          return props.panel.close;
        }
      });
    }
  });
}
function DcpPanel(props) {
  const theme = themeOf(props.context);
  const [screen, setScreen] = createSignal("overview");
  const session = createMemo(() => props.context.data.session.get(props.sessionID));
  const usage = createMemo(() => currentUsageTokens(session()?.tokens));
  const limit = createMemo(() => {
    const model = session()?.model;
    if (!model) return undefined;
    return modelContextLimit(props.context.data.location.model.list(props.context.location), model);
  });

  // The core's durable docs live in the host DB's `kv` table (the TUI's own
  // `context.storage` is a separate backend); read them read-only and poll
  // while the panel is open.
  const [doc, setDoc] = createSignal(emptyPanelDoc());
  const [allTime, setAllTime] = createSignal(zeroAllTime);
  const refreshDocs = async () => {
    const [sessionDoc, allTimeDoc] = await Promise.all([loadKvDoc(DCP_PLUGIN_ID, `dcp/state/${props.sessionID}`), loadKvDoc(DCP_PLUGIN_ID, ALL_TIME_KEY)]);
    setDoc(sessionDoc ?? emptyPanelDoc());
    setAllTime(allTimeDoc ?? zeroAllTime);
  };
  onMount(() => {
    void refreshDocs();
    const timer = setInterval(() => {
      void refreshDocs();
    }, 2000);
    onCleanup(() => {
      clearInterval(timer);
    });
  });
  const state = createMemo(() => buildPanelState(doc(), props.sessionID, props.config.manualMode.enabled));
  const [messages] = createResource(async () => {
    try {
      const entries = await props.context.client.session.context({
        sessionID: props.sessionID
      });
      return toWithParts(entries, props.sessionID);
    } catch {
      return [];
    }
  });
  const breakdown = createMemo(() => {
    const list = messages();
    if (!list) return undefined;
    return analyzeContextTokens(state(), list);
  });
  const stats = createMemo(() => buildSessionStatsSummary(state()));
  const manualActive = createMemo(() => state().manualMode !== false);
  const toggleManual = () => {
    const next = !manualActive();
    // Optimistic local update; the mirror file is what the core re-reads.
    setDoc(prev => ({
      ...prev,
      manualMode: next
    }));
    void writeManualMirror(props.sessionID, next).catch(() => {
      // A failed mirror write must not crash the panel.
    });
  };
  return (() => {
    var _el$ = _$createElement("box");
    _$setProp(_el$, "paddingLeft", 3);
    _$setProp(_el$, "paddingRight", 3);
    _$setProp(_el$, "paddingBottom", 1);
    _$setProp(_el$, "gap", 1);
    _$insert(_el$, _$createComponent(FrameHeader, {
      theme: theme,
      eyebrow: "DCP",
      get title() {
        return session()?.title;
      },
      get onClose() {
        return props.onClose;
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return screen() === "overview";
      },
      get children() {
        return _$createComponent(Overview, {
          theme: theme,
          usage: usage,
          limit: limit,
          stats: stats,
          manualActive: manualActive,
          onManual: toggleManual,
          onContext: () => setScreen("context"),
          onStats: () => setScreen("stats")
        });
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return screen() === "context";
      },
      get children() {
        return _$createComponent(ContextScreen, {
          theme: theme,
          breakdown: breakdown
        });
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return screen() === "stats";
      },
      get children() {
        return _$createComponent(StatsScreen, {
          theme: theme,
          stats: stats,
          get allTime() {
            return allTimeStats(allTime());
          }
        });
      }
    }), null);
    _$insert(_el$, _$createComponent(FrameFooter, {
      theme: theme,
      screen: screen,
      onBack: () => setScreen("overview"),
      onContext: () => setScreen("context"),
      onStats: () => setScreen("stats"),
      get onClose() {
        return props.onClose;
      }
    }), null);
    return _el$;
  })();
}
function FrameHeader(props) {
  return (() => {
    var _el$2 = _$createElement("box"),
      _el$3 = _$createElement("box"),
      _el$4 = _$createElement("text"),
      _el$5 = _$createElement("text");
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$5);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "justifyContent", "space-between");
    _$insertNode(_el$3, _el$4);
    _$setProp(_el$3, "flexDirection", "column");
    _$insert(_el$4, () => props.eyebrow);
    _$insert(_el$3, (() => {
      var _c$ = _$memo(() => !!props.title);
      return () => _c$() ? (() => {
        var _el$7 = _$createElement("text");
        _$insert(_el$7, () => props.title);
        _$effect(_p$ => {
          var _v$5 = props.theme.text,
            _v$6 = TextAttributes.BOLD;
          _v$5 !== _p$.e && (_p$.e = _$setProp(_el$7, "fg", _v$5, _p$.e));
          _v$6 !== _p$.t && (_p$.t = _$setProp(_el$7, "attributes", _v$6, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$7;
      })() : null;
    })(), null);
    _$insertNode(_el$5, _$createTextNode(`esc`));
    _$effect(_p$ => {
      var _v$ = props.theme.primary,
        _v$2 = TextAttributes.BOLD,
        _v$3 = props.theme.textMuted,
        _v$4 = props.onClose;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$4, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$4, "attributes", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$5, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$5, "onMouseUp", _v$4, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$2;
  })();
}
function FrameFooter(props) {
  return (() => {
    var _el$8 = _$createElement("box"),
      _el$9 = _$createElement("box");
    _$insertNode(_el$8, _el$9);
    _$setProp(_el$8, "flexDirection", "row");
    _$setProp(_el$8, "justifyContent", "space-between");
    _$setProp(_el$8, "paddingTop", 1);
    _$setProp(_el$9, "flexDirection", "row");
    _$setProp(_el$9, "gap", 1);
    _$insert(_el$9, _$createComponent(Show, {
      get when() {
        return props.screen() !== "overview";
      },
      get children() {
        return _$createComponent(Button, {
          get theme() {
            return props.theme;
          },
          label: "back",
          variant: "muted",
          get onClick() {
            return props.onBack;
          }
        });
      }
    }), null);
    _$insert(_el$9, _$createComponent(Show, {
      get when() {
        return props.screen() === "overview";
      },
      get children() {
        return [_$createComponent(Button, {
          get theme() {
            return props.theme;
          },
          label: "context",
          variant: "muted",
          get onClick() {
            return props.onContext;
          }
        }), _$createComponent(Button, {
          get theme() {
            return props.theme;
          },
          label: "stats",
          variant: "muted",
          get onClick() {
            return props.onStats;
          }
        })];
      }
    }), null);
    _$insert(_el$8, _$createComponent(Button, {
      get theme() {
        return props.theme;
      },
      label: "close",
      variant: "primary",
      get onClick() {
        return props.onClose;
      }
    }), null);
    return _el$8;
  })();
}
function Overview(props) {
  return (() => {
    var _el$0 = _$createElement("box");
    _$setProp(_el$0, "flexDirection", "column");
    _$setProp(_el$0, "gap", 1);
    _$insert(_el$0, _$createComponent(Card, {
      get theme() {
        return props.theme;
      },
      title: "Context",
      get children() {
        return _$createComponent(ProgressRow, {
          get theme() {
            return props.theme;
          },
          label: "usage",
          get value() {
            return props.usage();
          },
          get total() {
            return props.limit() ?? 0;
          },
          get detail() {
            return `${formatTokenCount(props.usage())} / ${props.limit() !== undefined ? formatTokenCount(props.limit() ?? 0) : "no limit"}`;
          }
        });
      }
    }), null);
    _$insert(_el$0, _$createComponent(Card, {
      get theme() {
        return props.theme;
      },
      title: "Manual mode",
      get children() {
        return _$createComponent(ManualModeToggle, {
          get theme() {
            return props.theme;
          },
          get active() {
            return props.manualActive();
          },
          get onToggle() {
            return props.onManual;
          }
        });
      }
    }), null);
    _$insert(_el$0, _$createComponent(Card, {
      get theme() {
        return props.theme;
      },
      title: "Session",
      get children() {
        return [_$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "pruned tokens",
          get value() {
            return formatTokenCount(props.stats().sessionTokens);
          }
        }), _$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "summary tokens",
          get value() {
            return formatTokenCount(props.stats().sessionSummaryTokens);
          }
        })];
      }
    }), null);
    _$insert(_el$0, _$createComponent(ActionRow, {
      get theme() {
        return props.theme;
      },
      title: "context",
      detail: "Token breakdown by role",
      get onClick() {
        return props.onContext;
      }
    }), null);
    _$insert(_el$0, _$createComponent(ActionRow, {
      get theme() {
        return props.theme;
      },
      title: "stats",
      detail: "Session and all-time stats",
      get onClick() {
        return props.onStats;
      }
    }), null);
    return _el$0;
  })();
}
function ContextScreen(props) {
  return _$createComponent(Show, {
    get when() {
      return props.breakdown();
    },
    keyed: true,
    get fallback() {
      return (() => {
        var _el$1 = _$createElement("text");
        _$insertNode(_el$1, _$createTextNode(`loading context…`));
        _$effect(_$p => _$setProp(_el$1, "fg", props.theme.textMuted, _$p));
        return _el$1;
      })();
    },
    children: b => (() => {
      var _el$11 = _$createElement("box");
      _$setProp(_el$11, "flexDirection", "column");
      _$setProp(_el$11, "gap", 1);
      _$insert(_el$11, _$createComponent(Card, {
        get theme() {
          return props.theme;
        },
        title: "Context tokens",
        get children() {
          return [_$createComponent(ProgressRow, {
            get theme() {
              return props.theme;
            },
            label: "system",
            get value() {
              return b.system;
            },
            get total() {
              return b.total;
            },
            get detail() {
              return formatTokenCount(b.system);
            }
          }), _$createComponent(ProgressRow, {
            get theme() {
              return props.theme;
            },
            label: "user",
            get value() {
              return b.user;
            },
            get total() {
              return b.total;
            },
            get detail() {
              return formatTokenCount(b.user);
            }
          }), _$createComponent(ProgressRow, {
            get theme() {
              return props.theme;
            },
            label: "assistant",
            get value() {
              return b.assistant;
            },
            get total() {
              return b.total;
            },
            get detail() {
              return formatTokenCount(b.assistant);
            }
          }), _$createComponent(ProgressRow, {
            get theme() {
              return props.theme;
            },
            label: "tools",
            get value() {
              return b.tools;
            },
            get total() {
              return b.total;
            },
            get detail() {
              return formatTokenCount(b.tools);
            }
          })];
        }
      }), null);
      _$insert(_el$11, _$createComponent(Card, {
        get theme() {
          return props.theme;
        },
        title: "Pruned",
        get children() {
          return [_$createComponent(Metric, {
            get theme() {
              return props.theme;
            },
            label: "pruned tokens",
            get value() {
              return formatTokenCount(b.prunedTokens);
            }
          }), _$createComponent(Metric, {
            get theme() {
              return props.theme;
            },
            label: "pruned tools",
            get value() {
              return String(b.prunedToolCount);
            }
          }), _$createComponent(Metric, {
            get theme() {
              return props.theme;
            },
            label: "pruned messages",
            get value() {
              return String(b.prunedMessageCount);
            }
          }), _$createComponent(Metric, {
            get theme() {
              return props.theme;
            },
            label: "tools in ctx",
            get value() {
              return `${b.toolsInContextCount} / ${b.toolCount}`;
            }
          })];
        }
      }), null);
      return _el$11;
    })()
  });
}
function StatsScreen(props) {
  const s = props.stats();
  return (() => {
    var _el$12 = _$createElement("box");
    _$setProp(_el$12, "flexDirection", "column");
    _$setProp(_el$12, "gap", 1);
    _$insert(_el$12, _$createComponent(Card, {
      get theme() {
        return props.theme;
      },
      title: "Session",
      get children() {
        return [_$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "pruned tokens",
          get value() {
            return formatTokenCount(s.sessionTokens);
          }
        }), _$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "summary tokens",
          get value() {
            return formatTokenCount(s.sessionSummaryTokens);
          },
          get hint() {
            return `ratio ${formatRatio(s.sessionTokens, s.sessionSummaryTokens)}`;
          }
        }), _$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "pruned tools",
          get value() {
            return String(s.sessionTools);
          }
        }), _$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "pruned messages",
          get value() {
            return String(s.sessionMessages);
          }
        }), _$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "compress time",
          get value() {
            return formatDuration(s.sessionDurationMs);
          }
        })];
      }
    }), null);
    _$insert(_el$12, _$createComponent(Card, {
      get theme() {
        return props.theme;
      },
      title: "All time",
      get children() {
        return [_$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "tokens",
          get value() {
            return formatTokenCount(props.allTime.totalTokens);
          }
        }), _$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "tools",
          get value() {
            return String(props.allTime.totalTools);
          }
        }), _$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "messages",
          get value() {
            return String(props.allTime.totalMessages);
          }
        }), _$createComponent(Metric, {
          get theme() {
            return props.theme;
          },
          label: "sessions",
          get value() {
            return String(props.allTime.sessionCount);
          }
        })];
      }
    }), null);
    return _el$12;
  })();
}
function Card(props) {
  return (() => {
    var _el$13 = _$createElement("box"),
      _el$14 = _$createElement("text");
    _$insertNode(_el$13, _el$14);
    _$setProp(_el$13, "flexDirection", "column");
    _$setProp(_el$13, "paddingLeft", 2);
    _$setProp(_el$13, "paddingRight", 2);
    _$setProp(_el$13, "paddingTop", 1);
    _$setProp(_el$13, "paddingBottom", 1);
    _$setProp(_el$13, "border", ["left"]);
    _$setProp(_el$13, "gap", 1);
    _$insert(_el$14, () => props.title);
    _$insert(_el$13, () => props.children, null);
    _$effect(_p$ => {
      var _v$7 = props.theme.backgroundElement,
        _v$8 = props.theme.primary,
        _v$9 = props.theme.primary,
        _v$0 = TextAttributes.BOLD;
      _v$7 !== _p$.e && (_p$.e = _$setProp(_el$13, "backgroundColor", _v$7, _p$.e));
      _v$8 !== _p$.t && (_p$.t = _$setProp(_el$13, "borderColor", _v$8, _p$.t));
      _v$9 !== _p$.a && (_p$.a = _$setProp(_el$14, "fg", _v$9, _p$.a));
      _v$0 !== _p$.o && (_p$.o = _$setProp(_el$14, "attributes", _v$0, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$13;
  })();
}
function Metric(props) {
  return (() => {
    var _el$15 = _$createElement("box"),
      _el$16 = _$createElement("box"),
      _el$17 = _$createElement("text"),
      _el$18 = _$createElement("box"),
      _el$19 = _$createElement("text");
    _$insertNode(_el$15, _el$16);
    _$insertNode(_el$15, _el$18);
    _$setProp(_el$15, "flexDirection", "row");
    _$setProp(_el$15, "gap", 2);
    _$insertNode(_el$16, _el$17);
    _$setProp(_el$16, "width", 24);
    _$insert(_el$17, () => props.label);
    _$insertNode(_el$18, _el$19);
    _$setProp(_el$18, "flexDirection", "row");
    _$setProp(_el$18, "gap", 1);
    _$setProp(_el$18, "flexGrow", 1);
    _$insert(_el$19, () => props.value);
    _$insert(_el$18, (() => {
      var _c$2 = _$memo(() => !!props.hint);
      return () => _c$2() ? (() => {
        var _el$20 = _$createElement("text");
        _$insert(_el$20, () => props.hint);
        _$effect(_$p => _$setProp(_el$20, "fg", props.theme.textMuted, _$p));
        return _el$20;
      })() : null;
    })(), null);
    _$effect(_p$ => {
      var _v$1 = props.theme.textMuted,
        _v$10 = props.theme.text,
        _v$11 = TextAttributes.BOLD;
      _v$1 !== _p$.e && (_p$.e = _$setProp(_el$17, "fg", _v$1, _p$.e));
      _v$10 !== _p$.t && (_p$.t = _$setProp(_el$19, "fg", _v$10, _p$.t));
      _v$11 !== _p$.a && (_p$.a = _$setProp(_el$19, "attributes", _v$11, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$15;
  })();
}
function ProgressRow(props) {
  const width = 32;
  const filled = props.total > 0 ? Math.max(0, Math.round(props.value / props.total * width)) : 0;
  const empty = Math.max(0, width - filled);
  return (() => {
    var _el$21 = _$createElement("box"),
      _el$22 = _$createElement("box"),
      _el$23 = _$createElement("box"),
      _el$24 = _$createElement("text"),
      _el$25 = _$createElement("box"),
      _el$26 = _$createElement("text"),
      _el$27 = _$createElement("text"),
      _el$28 = _$createElement("box"),
      _el$29 = _$createElement("text"),
      _el$30 = _$createElement("text");
    _$insertNode(_el$21, _el$22);
    _$insertNode(_el$21, _el$28);
    _$setProp(_el$21, "flexDirection", "column");
    _$setProp(_el$21, "gap", 0);
    _$insertNode(_el$22, _el$23);
    _$insertNode(_el$22, _el$25);
    _$setProp(_el$22, "flexDirection", "row");
    _$setProp(_el$22, "gap", 2);
    _$insertNode(_el$23, _el$24);
    _$setProp(_el$23, "width", 20);
    _$insert(_el$24, () => props.label);
    _$insertNode(_el$25, _el$26);
    _$insertNode(_el$25, _el$27);
    _$setProp(_el$25, "flexDirection", "row");
    _$setProp(_el$25, "gap", 1);
    _$setProp(_el$25, "flexGrow", 1);
    _$insert(_el$26, () => pct(props.value, props.total));
    _$insert(_el$27, () => props.detail);
    _$insertNode(_el$28, _el$29);
    _$insertNode(_el$28, _el$30);
    _$setProp(_el$28, "flexDirection", "row");
    _$insert(_el$29, () => "█".repeat(filled));
    _$insert(_el$30, () => "░".repeat(empty));
    _$effect(_p$ => {
      var _v$12 = props.theme.text,
        _v$13 = props.theme.text,
        _v$14 = TextAttributes.BOLD,
        _v$15 = props.theme.textMuted,
        _v$16 = props.theme.primary,
        _v$17 = props.theme.borderSubtle;
      _v$12 !== _p$.e && (_p$.e = _$setProp(_el$24, "fg", _v$12, _p$.e));
      _v$13 !== _p$.t && (_p$.t = _$setProp(_el$26, "fg", _v$13, _p$.t));
      _v$14 !== _p$.a && (_p$.a = _$setProp(_el$26, "attributes", _v$14, _p$.a));
      _v$15 !== _p$.o && (_p$.o = _$setProp(_el$27, "fg", _v$15, _p$.o));
      _v$16 !== _p$.i && (_p$.i = _$setProp(_el$29, "fg", _v$16, _p$.i));
      _v$17 !== _p$.n && (_p$.n = _$setProp(_el$30, "fg", _v$17, _p$.n));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined
    });
    return _el$21;
  })();
}
function ManualModeToggle(props) {
  const track = props.active ? props.theme.success : props.theme.error;
  return (() => {
    var _el$31 = _$createElement("box"),
      _el$32 = _$createElement("box"),
      _el$33 = _$createElement("text"),
      _el$35 = _$createElement("box"),
      _el$36 = _$createElement("text");
    _$insertNode(_el$31, _el$32);
    _$insertNode(_el$31, _el$35);
    _$setProp(_el$31, "flexDirection", "row");
    _$setProp(_el$31, "justifyContent", "space-between");
    _$setProp(_el$31, "paddingLeft", 1);
    _$setProp(_el$31, "paddingRight", 1);
    _$insertNode(_el$32, _el$33);
    _$setProp(_el$32, "width", 22);
    _$insertNode(_el$33, _$createTextNode(`Manual mode`));
    _$insertNode(_el$35, _el$36);
    _$setProp(_el$35, "backgroundColor", track);
    _$setProp(_el$35, "paddingLeft", 1);
    _$setProp(_el$35, "paddingRight", 1);
    _$insert(_el$36, () => props.active ? "   ■" : "■   ");
    _$effect(_p$ => {
      var _v$18 = props.theme.primary,
        _v$19 = TextAttributes.BOLD,
        _v$20 = props.onToggle,
        _v$21 = props.theme.background;
      _v$18 !== _p$.e && (_p$.e = _$setProp(_el$33, "fg", _v$18, _p$.e));
      _v$19 !== _p$.t && (_p$.t = _$setProp(_el$33, "attributes", _v$19, _p$.t));
      _v$20 !== _p$.a && (_p$.a = _$setProp(_el$35, "onMouseUp", _v$20, _p$.a));
      _v$21 !== _p$.o && (_p$.o = _$setProp(_el$36, "fg", _v$21, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$31;
  })();
}
function ActionRow(props) {
  return (() => {
    var _el$37 = _$createElement("box"),
      _el$38 = _$createElement("box"),
      _el$39 = _$createElement("box"),
      _el$40 = _$createElement("text"),
      _el$41 = _$createElement("text"),
      _el$42 = _$createElement("box"),
      _el$43 = _$createElement("text");
    _$insertNode(_el$37, _el$38);
    _$insertNode(_el$37, _el$42);
    _$setProp(_el$37, "flexDirection", "row");
    _$setProp(_el$37, "justifyContent", "space-between");
    _$setProp(_el$37, "paddingLeft", 1);
    _$setProp(_el$37, "paddingRight", 1);
    _$insertNode(_el$38, _el$39);
    _$insertNode(_el$38, _el$41);
    _$setProp(_el$38, "flexDirection", "row");
    _$setProp(_el$38, "gap", 2);
    _$insertNode(_el$39, _el$40);
    _$setProp(_el$39, "width", 12);
    _$insert(_el$40, () => props.title);
    _$insert(_el$41, () => props.detail);
    _$insertNode(_el$42, _el$43);
    _$setProp(_el$42, "paddingLeft", 2);
    _$setProp(_el$42, "paddingRight", 2);
    _$insertNode(_el$43, _$createTextNode(`open`));
    _$effect(_p$ => {
      var _v$22 = props.onClick,
        _v$23 = props.theme.primary,
        _v$24 = TextAttributes.BOLD,
        _v$25 = props.theme.text,
        _v$26 = props.theme.primary,
        _v$27 = props.theme.selectedListItemText;
      _v$22 !== _p$.e && (_p$.e = _$setProp(_el$37, "onMouseUp", _v$22, _p$.e));
      _v$23 !== _p$.t && (_p$.t = _$setProp(_el$40, "fg", _v$23, _p$.t));
      _v$24 !== _p$.a && (_p$.a = _$setProp(_el$40, "attributes", _v$24, _p$.a));
      _v$25 !== _p$.o && (_p$.o = _$setProp(_el$41, "fg", _v$25, _p$.o));
      _v$26 !== _p$.i && (_p$.i = _$setProp(_el$42, "backgroundColor", _v$26, _p$.i));
      _v$27 !== _p$.n && (_p$.n = _$setProp(_el$43, "fg", _v$27, _p$.n));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined
    });
    return _el$37;
  })();
}
function Button(props) {
  const primary = props.variant === "primary";
  return (() => {
    var _el$45 = _$createElement("box"),
      _el$46 = _$createElement("text");
    _$insertNode(_el$45, _el$46);
    _$setProp(_el$45, "paddingLeft", 2);
    _$setProp(_el$45, "paddingRight", 2);
    _$insert(_el$46, () => props.label);
    _$effect(_p$ => {
      var _v$28 = primary ? props.theme.primary : props.theme.backgroundElement,
        _v$29 = props.onClick,
        _v$30 = primary ? props.theme.selectedListItemText : props.theme.text;
      _v$28 !== _p$.e && (_p$.e = _$setProp(_el$45, "backgroundColor", _v$28, _p$.e));
      _v$29 !== _p$.t && (_p$.t = _$setProp(_el$45, "onMouseUp", _v$29, _p$.t));
      _v$30 !== _p$.a && (_p$.a = _$setProp(_el$46, "fg", _v$30, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$45;
  })();
}