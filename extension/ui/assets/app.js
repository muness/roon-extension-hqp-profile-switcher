(function () {
  const THEME_STORAGE_KEY = 'hqp-ui-theme';

  // Theme handling - run immediately to prevent flash
  function initTheme() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
  }

  function updateThemeIcon(theme) {
    const sunIcon = document.getElementById('theme-icon-sun');
    const moonIcon = document.getElementById('theme-icon-moon');
    const oledIcon = document.getElementById('theme-icon-oled');
    if (!sunIcon || !moonIcon || !oledIcon) return;

    sunIcon.classList.add('hidden');
    moonIcon.classList.add('hidden');
    oledIcon.classList.add('hidden');

    // Show icon for current state
    if (theme === 'light') {
      sunIcon.classList.remove('hidden');
    } else if (theme === 'oled') {
      oledIcon.classList.remove('hidden');
    } else {
      moonIcon.classList.remove('hidden');
    }
  }

  function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    let newTheme;

    // Cycle: dark → light → oled → dark
    if (currentTheme === 'dark') {
      newTheme = 'light';
    } else if (currentTheme === 'light') {
      newTheme = 'oled';
    } else {
      newTheme = 'dark';
    }

    if (newTheme === 'dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', newTheme);
    }

    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    updateThemeIcon(newTheme);
  }

  // Initialize theme immediately
  initTheme();

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
  let statusHqpTitle = null;
  let statusRequestedProfile = null;

  // Track if we're currently changing a setting (to avoid refresh conflicts)
  let pendingChange = false;

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

  function populateSelect(select, options, selectedValue) {
    if (!select || !options) return;

    const currentValue = select.value;
    select.innerHTML = options
      .map(opt => {
        const selected = opt.value === selectedValue ? " selected" : "";
        return `<option value="${escapeHtml(opt.value)}"${selected}>${escapeHtml(opt.label)}</option>`;
      })
      .join("");

    // Preserve selection if it was just changed
    if (pendingChange && currentValue) {
      select.value = currentValue;
    }
  }

  function renderPipeline(data) {
    if (!pipelineContent) return;

    pipelineLoading.classList.add("hidden");
    pipelineContent.classList.remove("hidden");

    const settings = data.settings || {};
    const status = data.status || {};

    // Populate dropdowns with options and selected values
    if (pipeMode && settings.mode) {
      populateSelect(pipeMode, settings.mode.options, settings.mode.selected?.value);
    }

    if (pipeRate && settings.samplerate) {
      populateSelect(pipeRate, settings.samplerate.options, settings.samplerate.selected?.value);
    }

    if (pipeFilter1x && settings.filter1x) {
      populateSelect(pipeFilter1x, settings.filter1x.options, settings.filter1x.selected?.value);
    }

    if (pipeFilterNx && settings.filterNx) {
      populateSelect(pipeFilterNx, settings.filterNx.options, settings.filterNx.selected?.value);
    }

    if (pipeShaper && settings.shaper) {
      populateSelect(pipeShaper, settings.shaper.options, settings.shaper.selected?.value);
    }

    // Output (read-only)
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

    // Show active HQPlayer config title
    if (statusHqpTitle) {
      statusHqpTitle.textContent = data.hqp_title || "-";
    }

    // Show last requested profile from extension
    if (statusRequestedProfile) {
      statusRequestedProfile.textContent = cfg.profile || "-";
    }

    const hostCell = cfg.host ? escapeHtml(cfg.host) : "not set";
    const portCell = cfg.port || "--";

    connectionBox.innerHTML =
      "<div><strong>Host:</strong> " + hostCell + ":" + portCell + "</div>";
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
    if (pendingChange) return; // Don't refresh while changing
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

  async function handlePipelineChange(event) {
    const select = event.target;
    const settingName = select.dataset.setting;
    const value = select.value;

    if (!settingName) return;

    pendingChange = true;
    select.disabled = true;

    try {
      await fetchJson("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: settingName, value }),
      });
      // Brief delay then refresh to get new state
      setTimeout(() => {
        pendingChange = false;
        select.disabled = false;
        refreshPipeline();
      }, 500);
    } catch (error) {
      banner(error.message, true);
      pendingChange = false;
      select.disabled = false;
      refreshPipeline();
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
    statusHqpTitle = document.getElementById("status-hqp-title");
    statusRequestedProfile = document.getElementById("status-requested-profile");

    if (profileForm) {
      profileForm.addEventListener("submit", handleSubmit);
    }

    // Add change handlers to pipeline selects
    const pipeSelects = document.querySelectorAll(".pipe-select");
    pipeSelects.forEach(select => {
      select.addEventListener("change", handlePipelineChange);
    });

    // Theme toggle
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', toggleTheme);
    }
    // Update icon to match current theme
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    updateThemeIcon(currentTheme);

    refreshAll();
    setInterval(refreshAll, 5000);
  }

  window.addEventListener("DOMContentLoaded", init);
})();
