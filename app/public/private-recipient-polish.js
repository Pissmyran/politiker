(() => {
  const EMAIL_SOURCE =
    "[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+";
  const localChar = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]/i;

  function* importedEmails(text) {
    const email = new RegExp(EMAIL_SOURCE, "iy");
    for (let i = 0; i < text.length;) {
      if (!localChar.test(text[i])) {
        i++;
        continue;
      }
      const start = i;
      // Every suffix of this local-part run would reach the same next character.
      // If the run cannot start an address, none of its suffixes can either.
      while (i < text.length && localChar.test(text[i])) i++;
      email.lastIndex = start;
      const match = email.exec(text);
      if (match) {
        yield { email: match[0].toLowerCase(), start, end: email.lastIndex };
        i = email.lastIndex;
      }
    }
  }

  function cleanImportedName(value) {
    const cleaned = String(value || "").replace(/[\u0000-\u001f\u007f<>]/g, " ");
    let start = 0;
    let end = cleaned.length;
    while (start < end && /[\s,;|"']/.test(cleaned[start])) start++;
    while (end > start && /[\s,;|"']/.test(cleaned[end - 1])) end--;
    return cleaned.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 160);
  }

  function importedDisplayNames(line, matches) {
    const names = new Map();
    const emailsByStart = new Map(matches.map((match) => [match.start, match]));
    let segmentStart = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "<" && i > segmentStart) {
        let pos = i + 1;
        while (pos < line.length && /\s/.test(line[pos])) pos++;
        const match = emailsByStart.get(pos);
        if (match) {
          pos = match.end;
          while (pos < line.length && /\s/.test(line[pos])) pos++;
          if (line[pos] === ">") {
            const name = cleanImportedName(line.slice(segmentStart, i));
            if (name) names.set(match.email, name);
          }
        }
      }
      if (",;<>\n".includes(line[i])) segmentStart = i + 1;
    }
    return names;
  }

  function inferImportedName(line, email, emailCount, displayNames) {
    if (displayNames.has(email)) return displayNames.get(email);
    if (emailCount !== 1) return "";

    const split =
      typeof globalThis.splitContactLine === "function"
        ? globalThis.splitContactLine(line)
        : line.split(/[\t;,]/).map((x) => x.trim());
    const emailColumn = split.findIndex((value) => String(value).toLowerCase().includes(email));
    if (emailColumn >= 0 && split.length > 1) {
      for (let distance = 1; distance < split.length; distance++) {
        for (const index of [emailColumn - distance, emailColumn + distance]) {
          if (index < 0 || index >= split.length) continue;
          const candidate = cleanImportedName(split[index]);
          if (
            !candidate ||
            candidate.includes("@") ||
            /^(?:namn|name|e-?post|email|mail)$/i.test(candidate)
          )
            continue;
          return candidate;
        }
      }
    }
    return "";
  }

  function parseFlexibleContactText(text) {
    const rows = [];
    const seen = new Set();
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const matches = [...importedEmails(line)];
      if (!matches.length) continue;
      const displayNames = importedDisplayNames(line, matches);
      for (const { email } of matches) {
        if (seen.has(email)) continue;
        seen.add(email);
        rows.push({ email, name: inferImportedName(line, email, matches.length, displayNames) });
        if (rows.length > 5000) throw new Error("Högst 5 000 mottagare kan importeras åt gången");
      }
    }
    if (!rows.length) throw new Error("Hittade inga giltiga e-postadresser i importen.");
    return rows;
  }

  function containsImportableEmail(value) {
    return !importedEmails(String(value || "")).next().done;
  }

  function polishPrivateRecipients() {
    const host = document.querySelector("#private-recipients");
    if (!host) return;

    const cards = [...host.querySelectorAll(".grid.grid--2 > .card")];
    const singleCard = cards[0];
    const importCard = cards[1];
    const entryGrid = importCard?.parentElement || singleCard?.parentElement;
    if (entryGrid) entryGrid.classList.add("private-entry-grid");

    const singleTitle = singleCard?.querySelector("h3");
    if (singleTitle) singleTitle.textContent = "Lägg till mottagare";

    const singleTemporary = document.querySelector("#private-use-once");
    const singleSave = document.querySelector("#private-save");
    if (singleTemporary) singleTemporary.textContent = "Lägg till i utskicket";
    if (singleSave) singleSave.textContent = "Spara och lägg till";

    if (importCard) {
      const details = document.createElement("details");
      details.className = "details private-import-details";
      const summary = document.createElement("summary");
      summary.textContent = "Importera flera mottagare";
      const body = document.createElement("div");
      body.className = "stack private-import-body";
      const hint = document.createElement("p");
      hint.className = "muted private-import-hint";
      hint.textContent =
        "Klistra in adresser fritt eller välj en CSV/TXT-fil. En eller flera adresser per rad fungerar, liksom komma, semikolon, tabeller och Namn <adress>.";
      body.append(hint);
      for (const child of [...importCard.children]) {
        if (child.tagName === "H3") continue;
        body.append(child);
      }
      details.append(summary, body);
      importCard.replaceWith(details);
    }

    const importTemporary = document.querySelector("#private-import-once");
    const importSave = document.querySelector("#private-import-save");
    if (importTemporary) importTemporary.textContent = "Lägg till adresser";
    if (importSave) importSave.textContent = "Spara som lista";

    const emailInput = document.querySelector("#private-email");
    const updateSingleButtons = () => {
      const enabled = containsImportableEmail(emailInput?.value);
      if (singleTemporary) singleTemporary.disabled = !enabled;
      if (singleSave) singleSave.disabled = !enabled;
    };
    emailInput?.addEventListener("input", updateSingleButtons);
    updateSingleButtons();

    const importText = document.querySelector("#private-import-text");
    const listName = document.querySelector("#private-list-name");
    const importFile = document.querySelector("#private-import-file");
    const updateImportButtons = () => {
      const hasAddress = containsImportableEmail(importText?.value);
      if (importTemporary) importTemporary.disabled = !hasAddress;
      if (importSave) importSave.disabled = !(hasAddress && String(listName?.value || "").trim());
    };
    importText?.addEventListener("input", updateImportButtons);
    listName?.addEventListener("input", updateImportButtons);
    if (importFile) {
      const originalChange = importFile.onchange;
      importFile.onchange = async (event) => {
        if (originalChange) await originalChange.call(importFile, event);
        updateImportButtons();
      };
    }
    updateImportButtons();
  }

  globalThis.parseContactText = parseFlexibleContactText;

  const originalRenderPrivateRecipients = globalThis.renderPrivateRecipients;
  if (typeof originalRenderPrivateRecipients === "function") {
    globalThis.renderPrivateRecipients = function (...args) {
      const result = originalRenderPrivateRecipients.apply(this, args);
      polishPrivateRecipients();
      return result;
    };
  }

  const originalRenderCompose = globalThis.renderCompose;
  if (typeof originalRenderCompose === "function") {
    globalThis.renderCompose = function (...args) {
      const result = originalRenderCompose.apply(this, args);
      const useFile = document.querySelector("#use-file");
      if (useFile) {
        useFile.textContent = "Använd vald fil som brevtext";
        useFile.classList.add("compose-use-file");
      }
      return result;
    };
  }
})();
