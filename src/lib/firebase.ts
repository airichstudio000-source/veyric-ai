import { initializeApp, getApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCXpIYFA77DnkSVAm0q1LLVASlPTlZV8-w",
  authDomain: "veyric-ai.firebaseapp.com",
  projectId: "veyric-ai",
  storageBucket: "veyric-ai.firebasestorage.app",
  messagingSenderId: "980547562309",
  appId: "1:980547562309:web:fe28bb17940940ed84ac2c",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();