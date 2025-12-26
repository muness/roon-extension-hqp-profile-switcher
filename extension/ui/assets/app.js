(function () {
  let profileSelect = null;
  let profileForm = null;
  let connectionBox = null;
  let bannerBox = null;

  // Pipeline elements
  let pipelineLoading = null;
  let pipelineContent = null;
  let pipeMode = null;
  let pipeRate = null;
  let pipeFilter1x = null;
  let pipeFilterNx = null;
  let pipeShaper = null;
  let pipeOutput = null;
  let volumeFill = null;
  let volumeText = null;
  let volumeSection = null;
  let statusState = null;
  let statusConnection = null;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function banner(message, isError) {
    if (!bannerBox) return;
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
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || response.statusText || "Request failed");
    }
    return response.json();
  }

  function renderPipeline(data) {
    if (!pipelineContent) return;

    pipelineLoading.classList.add("hidden");
    pipelineContent.classList.remove("hidden");

    const settings = data.settings || {};
    const status = data.status || {};

    // Mode
    if (pipeMode) {
      pipeMode.textContent = settings.mode?.selected?.label || status.activeMode || "-";
    }

    // Rate/Samplerate
    if (pipeRate) {
      const rate = settings.samplerate?.selected?.label || "Auto";
      pipeRate.textContent = rate === "0" ? "Auto" : rate;
    }

    // Filter 1x
    if (pipeFilter1x) {
      pipeFilter1x.textContent = settings.filter1x?.selected?.label || status.activeFilter || "-";
    }

    // Filter Nx
    if (pipeFilterNx) {
      pipeFilterNx.textContent = settings.filterNx?.selected?.label || "-";
    }

    // Shaper/Dither
    if (pipeShaper) {
      pipeShaper.textContent = settings.shaper?.selected?.label || status.activeShaper || "-";
    }

    // Output from status table
    if (pipeOutput) {
      pipeOutput.textContent = status.output || "-";
    }

    // Volume
    if (data.volume && volumeSection) {
      volumeSection.classList.remove("hidden");
      const vol = data.volume;
      const pct = ((vol.value - vol.min) / (vol.max - vol.min)) * 100;
      if (volumeFill) volumeFill.style.width = pct + "%";
      if (volumeText) {
        const label = vol.isFixed ? "Fixed" : vol.value + " dB";
        volumeText.textContent = label;
      }
    } else if (volumeSection) {
      volumeSection.classList.add("hidden");
    }

    // State
    if (statusState && status.state) {
      statusState.textContent = status.state;
      statusState.className = "status-value " + status.state.toLowerCase();
    }
  }

  function renderStatus(data) {
    if (!connectionBox) return;

    const cfg = data.config || {};
    const msg = data.status?.message || "Unknown";

    if (statusConnection) {
      statusConnection.textContent = msg;
      statusConnection.classList.toggle("error", !!data.status?.isError);
    }

    const hostCell = cfg.host ? escapeHtml(cfg.host) : "not set";
    const portCell = cfg.port || "--";
    const profileCell = cfg.profile || "not selected";

    connectionBox.innerHTML =
      "<div><strong>Host:</strong> " + hostCell + ":" + portCell + "</div>" +
      "<div><strong>Profile:</strong> " + escapeHtml(profileCell) + "</div>";
  }

  function renderProfiles(items) {
    if (!profileSelect) return;

    if (!items || !items.length) {
      profileSelect.innerHTML = '<option value="">No profiles available</option>';
      profileSelect.disabled = true;
      return;
    }

    const usable = items.filter(function (item) {
      if (!item) return false;
      const value = item.value != null ? String(item.value).trim() : "";
      return value.length && value.toLowerCase() !== "default";
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
        return '<option value="' + escapeHtml(value) + '">' + escapeHtml(label) + "</option>";
      })
      .join("");
  }

  async function refreshPipeline() {
    try {
      const data = await fetchJson("/api/pipeline");
      renderPipeline(data);
    } catch (error) {
      if (pipelineLoading) pipelineLoading.textContent = "Unable to load pipeline";
    }
  }

  async function refreshAll() {
    banner();

    try {
      const status = await fetchJson("/api/status");
      renderStatus(status);

      if (status.config?.host && status.config?.username && status.config?.port) {
        refreshPipeline();
        try {
          const response = await fetchJson("/api/profiles");
          if (response.restarting) {
            banner("Waiting for HQPlayer to restart...", false);
          }
          renderProfiles(response.profiles);
        } catch (error) {
          if (profileSelect) {
            profileSelect.innerHTML = "<option>" + escapeHtml(error.message) + "</option>";
            profileSelect.disabled = true;
          }
        }
      } else {
        if (profileSelect) {
          profileSelect.innerHTML = '<option value="">Set HQPlayer credentials first</option>';
          profileSelect.disabled = true;
        }
      }
    } catch (error) {
      banner(error.message || "Unable to load status.", true);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!profileSelect) return;

    const value = profileSelect.value;
    if (!value || !String(value).trim()) {
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
    profileSelect = document.getElementById("profile-select");
    profileForm = document.getElementById("profile-form");
    connectionBox = document.getElementById("connection-info");
    bannerBox = document.getElementById("banner");

    // Pipeline elements
    pipelineLoading = document.getElementById("pipeline-loading");
    pipelineContent = document.getElementById("pipeline-content");
    pipeMode = document.getElementById("pipe-mode");
    pipeRate = document.getElementById("pipe-rate");
    pipeFilter1x = document.getElementById("pipe-filter1x");
    pipeFilterNx = document.getElementById("pipe-filterNx");
    pipeShaper = document.getElementById("pipe-shaper");
    pipeOutput = document.getElementById("pipe-output");
    volumeFill = document.getElementById("volume-fill");
    volumeText = document.getElementById("volume-text");
    volumeSection = document.getElementById("volume-section");
    statusState = document.getElementById("status-state");
    statusConnection = document.getElementById("status-connection");

    if (profileForm) {
      profileForm.addEventListener("submit", handleSubmit);
    }

    refreshAll();
    setInterval(refreshAll, 5000); // Faster refresh for pipeline
  }

  window.addEventListener("DOMContentLoaded", init);
})();
