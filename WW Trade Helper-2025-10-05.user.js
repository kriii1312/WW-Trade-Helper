// ==UserScript==
// @name         WW Trade Helper
// @namespace    http://tampermonkey.net/
// @version      2025-10-05
// @description  Dropdown for WW
// @author       kriii1312
// @match        https://*.grepolis.com/game/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const $ = window.jQuery;

    // Versucht, verfügbare Lagerbestände aus dem Town-Model zu lesen (einfach & robust genug)
    function readAvailableResourcesFromTown(town) {
        if (!town) return null;
        try {
            // 1) gängigste Grepolis-API
            if (typeof town.getAvailableResources === 'function') {
                const r = town.getAvailableResources();
                if (r && r.wood !== undefined && r.stone !== undefined && r.iron !== undefined) {
                    return { wood: Number(r.wood)||0, stone: Number(r.stone)||0, iron: Number(r.iron)||0 };
                }
            }
            // 2) alternative Methode
            if (typeof town.getResources === 'function') {
                const r = town.getResources();
                if (r && r.wood !== undefined && r.stone !== undefined && r.iron !== undefined) {
                    return { wood: Number(r.wood)||0, stone: Number(r.stone)||0, iron: Number(r.iron)||0 };
                }
            }
            // 3) raw / attributes fallback (häufig vorhanden)
            if (town.raw && town.raw.resources) {
                const r = town.raw.resources;
                if (r) {
                    // keys können variieren — normalisieren
                    return {
                        wood: Number(r.wood || r.wood_amount || r[0] ) || 0,
                        stone: Number(r.stone || r.stone_amount || r[1] ) || 0,
                        iron:  Number(r.iron  || r.silver      || r.iron_amount || r[2]) || 0
                    };
                }
            }
            // 4) manchmal sind sie direkt als props vorhanden
            if (town.wood !== undefined || town.stone !== undefined || town.iron !== undefined) {
                return { wood: Number(town.wood)||0, stone: Number(town.stone)||0, iron: Number(town.iron)||0 };
            }
        } catch (e) {
            console.debug("WW Helper: readAvailableResourcesFromTown Fehler:", e);
        }
        return null;
    }

    // Berechnet die Verteilung (Basis + Restverteilung) und gibt fertiges send-Objekt zurück
    function computeDistribution(mode, u, avail) {
        // Basis (ganzzahlig)
        let w = 0, s = 0, i = 0;
        switch (mode) {
            case 0: w = s = i = Math.floor(u / 3); break;
            case 1: w = Math.floor(u); break;
            case 2: s = Math.floor(u); break;
            case 3: i = Math.floor(u); break;
            case 4: s = Math.floor(u / 2); i = u - s; break; // ohne Holz
            case 5: w = Math.floor(u / 2); i = u - w; break; // ohne Stein
            case 6: w = Math.floor(u / 2); s = u - w; break; // ohne Silber
            default: w = s = i = Math.floor(u / 3); break;
        }

        // Wenn wir verfügbare Lagerbestände haben, cappen wir die Basiswerte sofort
        if (avail) {
            w = Math.min(w, Math.floor(avail.wood || 0));
            s = Math.min(s, Math.floor(avail.stone || 0));
            i = Math.min(i, Math.floor(avail.iron || 0));
        }

        // Restkapazität
        let used = w + s + i;
        let rest = u - used;
        if (rest <= 0) return { wood: w, stone: s, iron: i };

        // Bestimme erlaubte Ziele
        let allowed = [];
        if (mode <= 3) {
            // alle drei grundsätzlich, aber nur solche mit noch Vorrat > current (falls avail vorhanden)
            if (!avail || (Math.floor(avail.wood||0) > w)) allowed.push('w');
            if (!avail || (Math.floor(avail.stone||0) > s)) allowed.push('s');
            if (!avail || (Math.floor(avail.iron||0) > i)) allowed.push('i');
        } else {
            // nur die beiden aktiven (die haben Basis>0), und nur wenn noch Reserve vorhanden
            if (w > 0 && (!avail || Math.floor(avail.wood||0) > w)) allowed.push('w');
            if (s > 0 && (!avail || Math.floor(avail.stone||0) > s)) allowed.push('s');
            if (i > 0 && (!avail || Math.floor(avail.iron||0) > i)) allowed.push('i');
        }

        // Wenn nichts erlaubt, fertig
        if (allowed.length === 0) return { wood: w, stone: s, iron: i };

        // Kapazität pro Ressource (wieviel noch zusätzlich möglich)
        const caps = {
            w: avail ? Math.max(0, Math.floor(avail.wood||0) - w) : Infinity,
            s: avail ? Math.max(0, Math.floor(avail.stone||0) - s) : Infinity,
            i: avail ? Math.max(0, Math.floor(avail.iron||0) - i) : Infinity
        };

        // Blockverteilung: gleich große Teile
        let per = Math.floor(rest / allowed.length);
        if (per > 0) {
            for (const r of allowed) {
                const add = Math.min(per, caps[r]);
                if (r === 'w') { w += add; caps.w -= add; }
                if (r === 's') { s += add; caps.s -= add; }
                if (r === 'i') { i += add; caps.i -= add; }
                rest -= add;
            }
        }

        // Rest 1-by-1 verteilen (nur auf Ressourcen mit noch Kapazität)
        let idx = 0;
        const maxLoops = allowed.length * 2000;
        let loops = 0;
        while (rest > 0 && loops < maxLoops) {
            const r = allowed[idx % allowed.length];
            if (r === 'w' && caps.w > 0) { w++; caps.w--; rest--; }
            else if (r === 's' && caps.s > 0) { s++; caps.s--; rest--; }
            else if (r === 'i' && caps.i > 0) { i++; caps.i--; rest--; }
            idx++; loops++;
            if ((caps.w <= 0) && (caps.s <= 0) && (caps.i <= 0)) break;
        }

        return { wood: w, stone: s, iron: i };
    }

    // Setzt die Werte in die Spinners (einmalig, mit kurzem Retry falls UI noch nicht fertig)
    function applyToSpinners(send, attempt = 0) {
        try {
            if (typeof WorldWonders !== 'undefined'
                && WorldWonders.spinners
                && WorldWonders.spinners.wood
                && typeof WorldWonders.spinners.wood.setValue === 'function') {

                WorldWonders.spinners.wood.setValue(send.wood);
                WorldWonders.spinners.stone.setValue(send.stone);
                WorldWonders.spinners.iron.setValue(send.iron);

                console.log("WW Trade Helper - applied:", send);
            } else {
                if (attempt < 6) {
                    setTimeout(() => applyToSpinners(send, attempt + 1), 120);
                } else {
                    console.warn("WW Trade Helper: Spinners nicht gefunden.");
                }
            }
        } catch (e) {
            console.error("WW Trade Helper applyToSpinners Fehler:", e);
        }
    }

    // === die angepasste updateWonderDistribution, minimal & direkt ===
    function updateWonderDistribution() {
        try {
            const sel = document.getElementById("wonder_distribution");
            if (!sel) return;
            const mode = parseInt(sel.value, 10);

            const town = MM.checkAndPublishRawModel("Town", { id: Game.townId });
            if (!town) {
                console.warn("WW Trade Helper: town model nicht vorhanden.");
                return;
            }

            const u = (typeof town.getAvailableTradeCapacity === 'function') ? town.getAvailableTradeCapacity() : null;
            if (!u || u <= 0) {
                console.warn("WW Trade Helper: keine Handelskapazität:", u);
                return;
            }

            // verfügbare Lagerbestände (einfach versuchen)
            const avail = readAvailableResourcesFromTown(town);
            if (!avail) {
                console.warn("WW Trade Helper: konnte Lagerbestände nicht lesen — Setze Basiswerte ohne Kappen.");
            }

            // Berechnen (Basis + Restverteilung)
            const send = computeDistribution(mode, u, avail);

            // Anwenden (einmalig)
            applyToSpinners(send);

        } catch (e) {
            console.error("WW Trade Helper updateWonderDistribution Fehler:", e);
        }
    }

    // === Dropdown anlegen / Ajax Listener wie in deinem Original ===
    function addWonderDropdown() {
        let u = MM.checkAndPublishRawModel("Town", {id: Game.townId}).getAvailableTradeCapacity();
        console.log("Trade capacity: " + u);

        try {
            if (u > 0) {
                if (!document.getElementById("wonder_distribution")) {
                    let select = $('<select id="wonder_distribution"></select>');

                    let options = [
                        "Gleichmäßig",
                        "Nur Holz",
                        "Nur Stein",
                        "Nur Silber",
                        "Ohne Holz",
                        "Ohne Stein",
                        "Ohne Silber"
                    ];
                    options.forEach((text, index) => {
                        select.append($('<option></option>').val(index).text(text));
                    });

                    let saved = localStorage.getItem("wonder_distribution_mode");
                    if (saved !== null) {
                        select.val(saved);
                    }

                    $(".wonder_res_container .send_resources_btn").after(select);

                    $('#wonder_distribution').css({
                        "position": "relative",
                        "top": "5px",
                        "display": "inline-block",
                        "margin-left": "10px",
                        "padding": "2px",
                        "font-size": "12px"
                    });

                    $('#wonder_distribution').on("change", function() {
                        localStorage.setItem("wonder_distribution_mode", this.value);
                        updateWonderDistribution();
                    });
                }

                updateWonderDistribution();
            }
        } catch (e) {
            console.error("Fehler beim WW Dropdown: ", e);
        }
    }

    // Ajax Listener wie bei dir
    $(document).ajaxComplete(function(event, xhr, settings) {
        if (settings.url && settings.url.includes("game/wonders")) {
            setTimeout(addWonderDropdown, 100);
        }
    });

    // Falls Fenster schon offen beim Laden
    setTimeout(addWonderDropdown, 400);

})();
