const navToggle = document.querySelector(".nav-toggle");
const body = document.body;
const headerMenu = document.querySelector(".header-menu");
const navLinks = document.querySelectorAll(".site-nav a, .header-actions a");

if (navToggle && headerMenu) {
  navToggle.addEventListener("click", () => {
    const isOpen = body.classList.toggle("menu-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      body.classList.remove("menu-open");
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

bindQueryParamValues();
setupAuthForms();
setupDashboardPage();
setupStripeCheckoutButtons();
setupExpandableImages();
setupDemoPage();

function bindQueryParamValues() {
  const queryTargets = document.querySelectorAll("[data-query-param]");
  if (!queryTargets.length) {
    return;
  }

  const params = new URLSearchParams(window.location.search);

  queryTargets.forEach((target) => {
    const key = target.getAttribute("data-query-param");
    const fallback = target.getAttribute("data-fallback") || "";
    const value = params.get(key);
    target.textContent = value || fallback;
  });
}

function setupAuthForms() {
  const authForms = document.querySelectorAll("[data-auth-form]");
  if (!authForms.length) {
    return;
  }

  authForms.forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const mode = form.getAttribute("data-auth-form");
      const submitButton = form.querySelector('button[type="submit"]');
      const message = form.querySelector("[data-form-message]");
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());

      if (message) {
        message.textContent = "";
      }

      const originalLabel = submitButton?.textContent || "";
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = mode === "register" ? "Creating..." : "Signing in...";
      }

      try {
        const response = await fetch(`/api/auth/${mode}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || "Authentication failed.");
        }

        const params = new URLSearchParams(window.location.search);
        const nextPath = params.get("next") || "/dashboard.html";
        window.location.href = nextPath;
      } catch (error) {
        if (message) {
          message.textContent = error.message || "Authentication failed.";
        }

        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalLabel;
        }
      }
    });
  });
}

async function setupDashboardPage() {
  const dashboardRoot = document.querySelector("[data-dashboard-root]");
  if (!dashboardRoot) {
    return;
  }

  const guestPanel = document.querySelector("[data-dashboard-guest]");
  const userPanel = document.querySelector("[data-dashboard-user]");
  const fields = document.querySelectorAll("[data-dashboard-field]");
  const logoutButton = document.querySelector("[data-logout-button]");
  const billingPortalButton = document.querySelector("[data-billing-portal-button]");
  const messageTarget = document.querySelector("[data-dashboard-message]");

  const response = await fetch("/api/me");
  const payload = await response.json();

  if (!response.ok || !payload.user) {
    if (guestPanel) {
      guestPanel.hidden = false;
    }
    if (userPanel) {
      userPanel.hidden = true;
    }
    return;
  }

  if (guestPanel) {
    guestPanel.hidden = true;
  }
  if (userPanel) {
    userPanel.hidden = false;
  }

  const subscription = payload.subscription;

  fields.forEach((field) => {
    const key = field.getAttribute("data-dashboard-field");

    switch (key) {
      case "name":
        field.textContent = payload.user.name || "Not set";
        break;
      case "email":
        field.textContent = payload.user.email || "-";
        break;
      case "customer":
        field.textContent = payload.user.stripeCustomerId || "Not created yet";
        break;
      case "plan":
        field.textContent = subscription?.plan_name || "No active plan";
        break;
      case "status":
        field.textContent = subscription?.status || "inactive";
        break;
      case "periodEnd":
        field.textContent = subscription?.current_period_end
          ? new Date(subscription.current_period_end).toLocaleDateString()
          : "-";
        break;
      case "cancelAtPeriodEnd":
        field.textContent = subscription?.cancel_at_period_end ? "Yes" : "No";
        break;
      default:
        break;
    }
  });

  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      await fetch("/api/auth/logout", {
        method: "POST",
      });
      window.location.href = "/auth.html";
    });
  }

  if (billingPortalButton) {
    billingPortalButton.addEventListener("click", async () => {
      if (messageTarget) {
        messageTarget.textContent = "";
      }

      const originalLabel = billingPortalButton.textContent;
      billingPortalButton.disabled = true;
      billingPortalButton.textContent = "Opening...";

      try {
        const portalResponse = await fetch("/api/create-billing-portal-session", {
          method: "POST",
        });
        const portalPayload = await portalResponse.json();

        if (!portalResponse.ok || !portalPayload.url) {
          throw new Error(portalPayload.error || "Could not open billing portal.");
        }

        window.location.href = portalPayload.url;
      } catch (error) {
        if (messageTarget) {
          messageTarget.textContent = error.message || "Could not open billing portal.";
        }
        billingPortalButton.disabled = false;
        billingPortalButton.textContent = originalLabel;
      }
    });
  }
}

async function setupStripeCheckoutButtons() {
  const checkoutButtons = document.querySelectorAll("[data-price-code]");
  if (!checkoutButtons.length || typeof window.Stripe !== "function") {
    return;
  }

  let stripeClient;

  async function getStripeClient() {
    if (stripeClient) {
      return stripeClient;
    }

    const response = await fetch("/api/config");
    const payload = await response.json();

    if (!response.ok || !payload.publishableKey) {
      throw new Error(payload.error || "Stripe publishable key is missing.");
    }

    stripeClient = window.Stripe(payload.publishableKey);
    return stripeClient;
  }

  checkoutButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Redirecting...";

      try {
        const stripe = await getStripeClient();
        const response = await fetch("/api/create-checkout-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            priceCode: button.getAttribute("data-price-code"),
          }),
        });

        const payload = await response.json();

        if (response.status === 401 && payload.authRequired) {
          const next = encodeURIComponent(window.location.pathname);
          window.location.href = `/auth.html?next=${next}`;
          return;
        }

        if (!response.ok || !payload.sessionId) {
          throw new Error(payload.error || "Could not create Stripe Checkout session.");
        }

        const result = await stripe.redirectToCheckout({
          sessionId: payload.sessionId,
        });

        if (result?.error) {
          throw new Error(result.error.message);
        }
      } catch (error) {
        alert(error.message || "Checkout failed. Check your Stripe configuration.");
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  });
}

function setupExpandableImages() {
  const triggers = document.querySelectorAll("[data-image-expand]");
  const modal = document.querySelector("[data-image-modal]");
  const modalImage = document.querySelector("[data-image-modal-image]");
  const closeButtons = document.querySelectorAll("[data-image-modal-close]");
  const primaryCloseButton = closeButtons[0];

  if (!triggers.length || !modal || !modalImage) {
    return;
  }

  let activeTrigger = null;

  const closeModal = () => {
    modal.hidden = true;
    body.classList.remove("image-modal-open");
    modalImage.src = "";
    modalImage.alt = "";

    if (activeTrigger) {
      activeTrigger.focus();
      activeTrigger = null;
    }
  };

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const src = trigger.getAttribute("data-image-src");
      const alt = trigger.getAttribute("data-image-alt") || "";

      if (!src) {
        return;
      }

      activeTrigger = trigger;
      modalImage.src = src;
      modalImage.alt = alt;
      modal.hidden = false;
      body.classList.add("image-modal-open");
      primaryCloseButton?.focus();
    });
  });

  closeButtons.forEach((button) => {
    button.addEventListener("click", closeModal);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      closeModal();
    }
  });
}

function setupDemoPage() {
  const navButtons = document.querySelectorAll("[data-demo-nav]");
  const panels = document.querySelectorAll("[data-demo-panel]");

  if (!navButtons.length || !panels.length) {
    return;
  }

  const setActiveStep = (step) => {
    navButtons.forEach((button) => {
      const isActive = button.getAttribute("data-demo-nav") === step;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });

    panels.forEach((panel) => {
      panel.hidden = panel.getAttribute("data-demo-panel") !== step;
    });
  };

  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const step = button.getAttribute("data-demo-nav");
      if (step) {
        setActiveStep(step);
      }
    });
  });

  const params = new URLSearchParams(window.location.search);
  const requestedStep = params.get("step");
  const defaultStep = navButtons[0]?.getAttribute("data-demo-nav");
  const hasRequestedStep = Array.from(navButtons).some(
    (button) => button.getAttribute("data-demo-nav") === requestedStep
  );

  setActiveStep(hasRequestedStep ? requestedStep : defaultStep);
}
