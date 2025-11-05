(function () {
  let statusBox = null;
  let profileSelect = null;
  let profileForm = null;
  let connectionBox = null;
  let bannerBox = null;

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function banner(message, isError) {
    if (!bannerBox) {
      return;
    }

    if (!message) {
      bannerBox.textContent = "";
      bannerBox.classList.remove("error");
      bannerBox.classList.add("hidden");
      return;
    }

    bannerBox.textContent = message;
    bannerBox.classList.toggle("error", !!isError);
    bannerBox.classList.remove("hidden");
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const body = await response.json().catch(function () {
        return {};
      });
      const message = body.error || response.statusText || "Request failed";
      throw new Error(message);
    }
    return response.json();
  }

  function renderStatus(data) {
    if (!statusBox || !connectionBox) {
      return;
    }

    statusBox.textContent = data.status.message;
    statusBox.classList.toggle("error", !!data.status.isError);

    const cfg = data.config || {};
    const hostCell = cfg.host ? escapeHtml(String(cfg.host)) : "<em>not set</em>";
    const portCell = cfg.port ? escapeHtml(String(cfg.port)) : "--";
    const userCell = cfg.username ? escapeHtml(String(cfg.username)) : "<em>not set</em>";
    const profileCell = cfg.profile
      ? escapeHtml(String(cfg.profile))
      : '<em>not selected</em>';
    const sourceNameCell = cfg.source_control_name
      ? escapeHtml(String(cfg.source_control_name))
      : escapeHtml("Profile");

    connectionBox.innerHTML =
      '<div><strong>HQPlayer Host:</strong> ' +
      hostCell +
      "</div>" +
      '<div><strong>HQPlayer Port:</strong> ' +
      portCell +
      "</div>" +
      '<div><strong>Username:</strong> ' +
      userCell +
      "</div>" +
      '<div><strong>Selected Profile:</strong> ' +
      profileCell +
      "</div>" +
      '<div><strong>Source Control Name:</strong> ' +
      sourceNameCell +
      "</div>";
  }

  function renderProfiles(items) {
    if (!profileSelect) {
      return;
    }

    if (!items || !items.length) {
      profileSelect.innerHTML = '<option value="">No profiles available</option>';
      profileSelect.disabled = true;
      return;
    }

    const usable = items.filter(function (item) {
      if (!item) return false;
      const value = item.value !== undefined && item.value !== null ? String(item.value).trim() : "";
      if (!value.length) return false;
      return value.toLowerCase() !== "default";
    });

    if (!usable.length) {
      profileSelect.innerHTML = '<option value="">No profiles available</option>';
      profileSelect.disabled = true;
      return;
    }

    profileSelect.disabled = false;
    profileSelect.innerHTML = usable
      .map(function (item) {
        const value = String(item.value).trim();
        const label = item.title || value || "Unnamed profile";
        return (
          '<option value="' + escapeHtml(String(value)) + '">' + escapeHtml(String(label)) + "</option>"
        );
      })
      .join("");
  }

  async function refreshAll() {
    banner();

    try {
      const status = await fetchJson("/api/status");
      renderStatus(status);

      if (status.config && status.config.host && status.config.username && status.config.port) {
        try {
          const response = await fetchJson("/api/profiles");
          if (response.restarting) {
            banner("Waiting for HQPlayer to restart after profile change...", false);
          }
          renderProfiles(response.profiles);
        } catch (error) {
          profileSelect.innerHTML = "<option>" + escapeHtml(error.message) + "</option>";
          profileSelect.disabled = true;
        }
      } else {
        profileSelect.innerHTML = '<option value="">Set HQPlayer credentials first</option>';
        profileSelect.disabled = true;
      }
    } catch (error) {
      banner(error.message || "Unable to load status.", true);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (!profileSelect) {
      return;
    }

    const value = profileSelect.value;
    if (value === null || value === undefined || String(value).trim() === "") {
      banner("Choose a profile to load.", true);
      return;
    }

    try {
      await fetchJson("/api/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: value }),
      });
      banner("Profile load requested.", false);
      await refreshAll();
    } catch (error) {
      banner(error.message, true);
      await refreshAll();
    }
  }

  function init() {
    statusBox = document.getElementById("status");
    profileSelect = document.getElementById("profile-select");
    profileForm = document.getElementById("profile-form");
    connectionBox = document.getElementById("connection-info");
    bannerBox = document.getElementById("banner");

    if (profileForm) {
      profileForm.addEventListener("submit", handleSubmit);
    }

    refreshAll();
    setInterval(refreshAll, 15000);
  }

  window.addEventListener("DOMContentLoaded", init);
})();
