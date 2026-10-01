import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import "./App.css";

function Home() {
  const { session, loading } = useAuth();
  // Session lives in an httpOnly cookie; while /auth/me is checking it, don't
  // flash a redirect to /login for someone who's actually signed in.
  if (loading) return null;
  if (!session) return <Navigate to="/login" replace />;
  return <Dashboard />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={<Home />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
