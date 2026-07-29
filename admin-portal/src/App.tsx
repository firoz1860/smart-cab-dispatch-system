import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ToastProvider } from "./components/Toast";
import { Login } from "./pages/Login";
import { AdminDashboard } from "./pages/AdminDashboard";
import { DriverView } from "./pages/DriverView";
import { GuestDashboard } from "./pages/GuestDashboard";
import "./App.css";

function RoleGate() {
  const { session, loading } = useAuth();
  // Session lives in an httpOnly cookie; while /auth/me is checking it,
  // don't flash a redirect to /login for someone who's actually signed in.
  if (loading) return null;
  if (!session) return <Navigate to="/login" replace />;
  if (session.role === "ADMIN") return <AdminDashboard />;
  if (session.role === "DRIVER") return <DriverView />;
  if (session.role === "GUEST") return <GuestDashboard />;
  return <Navigate to="/login" replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/*" element={<RoleGate />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
