import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Login } from "./pages/Login";
import { AdminDashboard } from "./pages/AdminDashboard";
import { DriverView } from "./pages/DriverView";
import "./App.css";

function RoleGate() {
  const { session } = useAuth();
  if (!session) return <Navigate to="/login" replace />;
  if (session.role === "ADMIN") return <AdminDashboard />;
  if (session.role === "DRIVER") return <DriverView />;
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
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
