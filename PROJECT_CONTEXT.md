# PROJECT CONTEXT - CancerCulture

Last updated: 2026-04-23

## Produktstatus

CancerCulture ist aktuell wieder klar als laufende Meme-Competition mit Coin-/Launch-Charakter gedacht.

Wichtig:

* kein Sponsored-Cycle-Produkt mehr in diesem Projekt
* Sponsored-Logik wurde bewusst wieder entfernt bzw. stillgelegt
* Fokus liegt auf Cycles, Upload, Vote, Reveal, Fame/Shame und Community-Flow

Kernidee:

* Discord-OAuth als Zugang
* 1 aktiver Cycle zur gleichen Zeit
* 1 Submission pro User pro Cycle
* 1 Vote pro User pro Cycle
* anonyme Competition waehrend aktiver Cycles
* Reveal / History / Winner-Darstellung danach

---

## Tech Stack

* Next.js App Router
* Supabase fuer DB + auth-nahe Daten
* Discord OAuth
* Cloudflare R2 fuer Upload-Storage
* Cloudflare fuer Delivery / Domain
* Vercel fuer Hosting / Serverlogik

---

## Technische Leitlinien

* bestehende Architektur und zentrale Helper bevorzugen
* keine doppelte Logik
* Server ist Source of Truth
* bestehende Resize- + R2-Flows nicht unnötig anfassen
* Moderation, Upload-Checks und Cycle-Checks wenn moeglich zentral halten

Wichtige Sicherheits-/Stabilitaetspunkte, die inzwischen umgesetzt sind:

* Discord OAuth hat jetzt echten `state`-Schutz
* automatische Invite->Mod-Vergabe wurde entfernt
* Mod-Rechte werden jetzt direkt durch Admin vergeben
* DB-Unique-Absicherung fuer:
  * `votes (cycle_id, discord_user_id)`
  * `submissions (cycle_id, discord_user_id)`
* Duplicate-Faelle werden in Vote/Upload sauber abgefangen und geloggt
* Upload raeumt ein frisch hochgeladenes R2-Objekt wieder auf, wenn der DB-Teil danach scheitert

---

## Aktuelle Produktlogik

### Cycles

Es gibt genau ein Cycle-System.

Aktive sichtbare Cycle-Bezeichnung:

* `theme`

Wichtig:

* `title` wird nicht als aktive sichtbare Cycle-Bezeichnung verwendet
* auf der Startseite / im HUD soll das aktuelle Theme angezeigt werden
* `next_cycle_theme` ist ein Admin-Draft:
  * kann vorab gesetzt werden
  * wird auf der Startseite als `Next Theme` angezeigt
  * wird beim naechsten Cycle-Start automatisch als aktuelles Theme uebernommen
  * verschwindet danach wieder als `Next Theme`, weil es dann das aktuelle Theme ist

Cycle-Status:

* aktiv: `active`
* beendet/final: in der Produktlogik als `FINALIZED` anzeigen

### Gewinnerdarstellung

Es gibt aktiv:

* `Wall of Fame`
* `Wall of Shame`

Regel:

* mindestens `1%` Charity-Anteil -> `Wall of Fame`
* alles behalten -> `Wall of Shame`

Das bedeutet aktuell:

* `donate` -> Fame
* `split` -> Fame
* `keep` -> Shame

### Zugriff

Oeffentlich sichtbar:

* Landing Page
* FAQ
* Rules
* Wall of Fame
* Wall of Shame

Per OAuth / eingeloggte User:

* Upload
* Vote
* My Profile
* Cycle History
* Userprofile anderer eingeloggter User

---

## Was aktuell aktiv umgesetzt ist

### Upload / Vote

Bereits umgesetzt:

* 1 Submission pro User pro Cycle
* 1 Vote pro User pro Cycle
* serverseitige Checks plus DB-Unique-Absicherung
* Duplicate-Versuche werden sauber als normale Fail-/Reject-Faelle behandelt
* wenn kein aktiver Cycle existiert:
  * Vote-Seite zeigt klaren Empty State
  * Upload-Seite ist ebenfalls direkt gesperrt und zeigt klar `No active cycle right now`

Payout-Logik im Upload:

* `keep` braucht Wallet
* `split` braucht Wallet
* `donate` braucht keine Wallet
* bei `donate` wird das Wallet-Feld ausgeblendet

### Socials

Die alte einzelne `x_username`-Eingabe ist produktseitig ersetzt worden durch ein Social-System.

Aktueller Stand:

* User pflegt Socials im Profil
* Plattformen aktuell:
  * X
  * Instagram
  * TikTok
  * Facebook
* jede Social kann `verified` oder `unverified` sein
* Verification ist fuer alle User sichtbar
* Mods und Admins koennen verify / unverify
* Verifizierungslogs existieren im Admin-Bereich

Wichtige Sichtbarkeitsregeln:

* `show_socials` = auf Profil zeigen
* `show_socials_on_submissions` = nur verifizierte Socials in Submissions einbauen

Submission-Verhalten:

* bei Upload werden nur verifizierte Socials als Snapshot gespeichert
* diese Socials bleiben an der Submission haengen, auch wenn der User sie spaeter im Profil aendert oder ausblendet

Socials werden angezeigt in:

* Userprofilen
* Reveal-/History-Modals
* Wall of Fame / Wall of Shame Modals

Nicht mehr auf den History-Cards selbst:

* in der Cycle History nur noch im geoeffneten Modal, nicht in der Card

### Profile

`My Profile` zeigt aktuell:

* Avatar
* Join-Datum
* aktuellen Discord-Namen
* Discord-ID
* Socials-Sektion
* Current Cycle
* Submissions
* Votes

### Moderation / Legal Review

Bereits umgesetzt:

* normale Submission-Moderation fuer aktiven Cycle
* Mods/Admins koennen alte/revealed Submissions im History-/Detail-Kontext moderieren
* eigener `Legal Review`-Bereich im Admin-Menue
* Badge/Notification fuer offene Legal-Review-Faelle
* eigener Bereich fuer `Removed from Public`
* Admin-/Mod-Logs dafuer vorhanden

### Admin / User Logs / Rollen

Bereits umgesetzt:

* User Logs koennen nach Discord-ID durchsucht werden
* Usernamen sind dort direkt aufs Profil verlinkt
* Admin kann Mods direkt ueber `Make Mod` / `Remove Mod` setzen
* Invite-basierte Mod-Onboarding-Logik ist retired

### Logging

Bereits umgesetzt:

* Upload Logs
* Vote Logs
* Moderation Logs
* Social Verification Logs
* Avatar Upload Logs

Upload- und Vote-Logs sind innerhalb eines Cycles nach Status gruppiert:

* `FAILED`
* `SUCCESS`
* andere Status danach

---

## Was bewusst nicht mehr aktiv ist

### Sponsored Cycles

Fuer dieses Projekt derzeit nicht aktiv.

Das bedeutet:

* keine Sponsored-Cycle-Produktlogik weiterbauen
* keine Sponsor-Banner weiterverfolgen
* keine Sponsoring-Regeln fuer dieses Projekt als Prioritaet behandeln

Falls im Code/DB noch Felder oder alte Basis dafuer existieren, sind sie aktuell nicht Teil des aktiven Produktfokus.

### Invite-basierte Mod-Rechte

Retired.

Aktiver Weg:

* Admin setzt Mod-Rechte direkt im Admin-/User-Log-Bereich

---

## Daten / Tabellen, die aktuell wichtig sind

### Core

* `voting_cycles`
* `submissions`
* `submission_private_data`
* `votes`
* `cycle_results`
* `winner_public_profiles`

### User / Auth / Team

* `sessions`
* `user_logs`
* `team_members`

### Moderation / Logging

* `upload_logs`
* `vote_logs`
* `moderation_action_logs`
* `avatar_upload_logs`
* `social_verification_logs`
* `blocked_cycle_events`
* `blocked_user_meta`

### Socials

* `user_social_links`
* `submission_social_links`

### Config / Rules

* `app_config`
* `rules_meta`
* `cycle_rule_templates`
* `user_cycle_acceptance`
* `next_cycle_config`

Hinweis:

* die Rules-Datenbasis existiert
* ein voller per-cycle Rules-/Acceptance-Flow ist aber noch nicht final als kompletter Produkt-Flow ausgebaut

---

## UI / Terminologie

Bitte konsistent bleiben:

* `Cycle` statt `Round`, wenn neue UI angepasst oder gebaut wird
* `Wall of Fame`
* `Wall of Shame`
* `Wallet:` statt `Wallet Address:`

Im HUD / Status:

* beendete Cycles produktseitig als `FINALIZED` anzeigen

---

## Was aktuell noch offen / spaeter dran ist

### Kommentarbereich

Das ist der naechste groessere Produktblock und wurde bewusst bis zum Schluss verschoben.

Soll spaeter voraussichtlich enthalten:

* Kommentare pro Submission / Modal
* Moderation
* evtl. Edit / Delete
* lazy loading
* keine Realtime-Pflicht

### Voller Rules-/Acceptance-Flow

Teilweise vorbereitet, aber noch nicht als kompletter End-to-End-Produktflow fertig.

### Weitere kleine UX-/Admin-Verbesserungen

Moeglich, aber nachrangig gegenueber der Kommentarsektion.

---

## Wichtige Hinweise fuer den naechsten Chat

Wenn ein neuer Chat startet:

* zuerst diese `PROJECT_CONTEXT.md` lesen
* kein Sponsored-Cycle-Projekt daraus machen
* `theme` ist die aktive sichtbare Cycle-Bezeichnung
* Fame und Shame sind beide aktiv
* Socials-System ist bereits eingebaut und soll weiterverwendet werden
* Admin-/Mod-Rollen laufen direkt ueber `team_members`, nicht mehr ueber Invites
* Duplicate-/Race-Condition-Schutz bei Upload/Vote ist bereits gehaertet
* bestehende zentrale Helper und bestehende Architektur bevorzugen
