// =====================================================================
// AUTH: who is using the app, and what are they allowed to see
// ---------------------------------------------------------------------
// Two modes:
//   FIREBASE  -> real sign-in (email + password, Firebase Authentication).
//                The user's role comes from Firestore: users/{uid}
//                { role: "owner"|"hub"|"driver"|"vendor", name, vendorId?, driverId? }
//                Access is ENFORCED by firestore.rules on the server.
//   DEMO      -> pick a demo user. Clearly labelled as NOT secure:
//                anyone can choose any role. Used until Firebase is set up.
// =====================================================================

const Auth = (() => {
  // Screens each role can open (the first one opens by default)
  const ROLE_TABS = {
    owner:  ["insights", "hub", "driver", "vendor", "ivr"],
    hub:    ["hub", "driver"],
    driver: ["driver"],
    vendor: ["vendor", "ivr"],
  };
  const ROLE_NAME = { owner: "Owner", hub: "Hub staff", driver: "Driver", vendor: "Vendor" };

  // Demo users (demo mode only)
  const DEMO_USERS = [
    { uid: "demo-owner", role: "owner", name: "Dhumbi Shree B R" },
    { uid: "demo-hub", role: "hub", name: "Ward 45 hub" },
    { uid: "demo-d1", role: "driver", driverId: "d1", name: "Mahesh" },
    { uid: "demo-d2", role: "driver", driverId: "d2", name: "Kiran" },
    { uid: "demo-v1", role: "vendor", vendorId: "v1", name: "Ravi" },
    { uid: "demo-v2", role: "vendor", vendorId: "v2", name: "Manjula" },
    { uid: "demo-v3", role: "vendor", vendorId: "v3", name: "Imran" },
    { uid: "demo-v4", role: "vendor", vendorId: "v4", name: "Lakshmamma" },
    { uid: "demo-v5", role: "vendor", vendorId: "v5", name: "Suresh" },
  ];
  const SS_KEY = "cocoloop-demo-user";

  let mode = "demo";        // "firebase" | "demo"
  let user = null;
  let onChange = () => {};
  let forcedDemo = false;

  const firebaseConfigured = () =>
    typeof firebase !== "undefined" && firebase.auth && typeof firebaseConfig !== "undefined" && !!firebaseConfig.apiKey;

  function init(callback) {
    onChange = callback;
    if (firebaseConfigured() && !forcedDemo) {
      try {
        if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
        mode = "firebase";
        firebase.auth().onAuthStateChanged(async fbUser => {
          if (!fbUser) { user = null; onChange(user); return; }
          try {
            const snap = await firebase.firestore().collection("users").doc(fbUser.uid).get();
            const data = snap.exists ? snap.data() : {};
            user = { uid: fbUser.uid, email: fbUser.email, name: data.name || fbUser.email, role: ROLE_TABS[data.role] ? data.role : null,
                     vendorId: data.vendorId || null, driverId: data.driverId || null };
          } catch (e) {
            console.error(e);
            user = { uid: fbUser.uid, email: fbUser.email, name: fbUser.email, role: null, error: "Could not read your role from Firestore." };
          }
          onChange(user);
        });
        return;
      } catch (e) { console.error("Firebase init failed", e); }
    }
    mode = "demo";
    let saved = null;
    try { saved = sessionStorage.getItem(SS_KEY); } catch (e) {}
    user = DEMO_USERS.find(u => u.uid === saved) || null;
    onChange(user);
  }

  function signInDemo(uid) {
    user = DEMO_USERS.find(u => u.uid === uid) || null;
    try { sessionStorage.setItem(SS_KEY, uid); } catch (e) {}
    onChange(user);
  }

  async function signInEmail(email, password) {
    await firebase.auth().signInWithEmailAndPassword(email, password);   // onAuthStateChanged does the rest
  }

  // Use demo mode on this device even though Firebase is configured (e.g. no accounts yet)
  function useDemoInstead() { forcedDemo = true; mode = "demo"; user = null; onChange(user); }

  async function signOut() {
    if (mode === "firebase") await firebase.auth().signOut();
    else { try { sessionStorage.removeItem(SS_KEY); } catch (e) {} user = null; onChange(user); }
  }

  const tabsFor = role => ROLE_TABS[role] || [];
  const can = tab => !!user && tabsFor(user.role).includes(tab);

  // Which pickups this user may load. The same filter is enforced by firestore.rules.
  function pickupQuery() {
    if (!user) return null;
    if (user.role === "vendor") return ["vendorUid", user.uid];
    if (user.role === "driver") return ["driverUid", user.uid];
    return null;   // owner and hub: all pickups
  }

  return { init, signInDemo, signInEmail, signOut, useDemoInstead, can, tabsFor, pickupQuery,
           mode: () => mode, user: () => user, firebaseConfigured, DEMO_USERS, ROLE_NAME };
})();
