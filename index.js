export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const jsonResponse = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });

    try {
      // Pastikan tabel database otomatis ada (Auto-Migration)
      await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            department TEXT NOT NULL,
            registered_at TEXT NOT NULL,
            face_vector TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attendance (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            user_name TEXT NOT NULL,
            user_email TEXT NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'Hadir',
            method TEXT NOT NULL DEFAULT 'Scan Wajah'
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO settings (key, value) VALUES ('threshold', '0.45');
      `);

      // 1. GET /api/bootstrap (Muat semua data awal)
      if (pathname === "/api/bootstrap" && method === "GET") {
        const { results: userRows } = await env.DB.prepare(
          "SELECT id, name, email, department, registered_at, face_vector FROM users ORDER BY registered_at DESC"
        ).all();

        const users = [];
        const faceData = {};
        for (const row of userRows) {
          users.push({
            id: row.id,
            name: row.name,
            email: row.email,
            department: row.department,
            registeredAt: row.registered_at,
          });
          if (row.face_vector) {
            faceData[row.id] = JSON.parse(row.face_vector);
          }
        }

        const { results: attRows } = await env.DB.prepare(
          "SELECT id, user_id, user_name, user_email, date, time, timestamp, status, method FROM attendance ORDER BY timestamp DESC"
        ).all();

        const attendance = attRows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          userName: r.user_name,
          userEmail: r.user_email,
          date: r.date,
          time: r.time,
          timestamp: r.timestamp,
          status: r.status,
          method: r.method,
        }));

        const thresholdRow = await env.DB.prepare(
          "SELECT value FROM settings WHERE key = 'threshold'"
        ).first();

        const settings = {
          threshold: thresholdRow ? parseFloat(thresholdRow.value) : 0.45,
        };

        return jsonResponse({ success: true, users, faceData, attendance, settings });
      }

      // 2. POST /api/users (Simpan user & faceVector baru)
      if (pathname === "/api/users" && method === "POST") {
        const body = await request.json();
        const { id, name, email, department, registeredAt, faceVector } = body;

        if (!id || !name || !email || !department || !faceVector) {
          return jsonResponse({ success: false, error: "Data tidak lengkap." }, 400);
        }

        const existing = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
        if (existing) {
          return jsonResponse({ success: false, error: `ID "${id}" sudah terdaftar.` }, 409);
        }

        await env.DB.prepare(
          `INSERT INTO users (id, name, email, department, registered_at, face_vector) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(id, name, email, department, registeredAt || new Date().toISOString(), JSON.stringify(faceVector)).run();

        return jsonResponse({ success: true });
      }

      // 3. PUT & DELETE /api/users/:id
      if (pathname.startsWith("/api/users/")) {
        const userId = decodeURIComponent(pathname.replace("/api/users/", ""));

        if (method === "PUT") {
          const body = await request.json();
          await env.DB.prepare("UPDATE users SET name = ?, email = ?, department = ? WHERE id = ?")
            .bind(body.name, body.email, body.department, userId).run();
          return jsonResponse({ success: true });
        }

        if (method === "DELETE") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM attendance WHERE user_id = ?").bind(userId),
            env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
          ]);
          return jsonResponse({ success: true });
        }
      }

      // 4. POST & DELETE /api/attendance
      if (pathname === "/api/attendance") {
        if (method === "POST") {
          const body = await request.json();
          const already = await env.DB.prepare("SELECT id FROM attendance WHERE user_id = ? AND date = ?")
            .bind(body.userId, body.date).first();

          if (already) {
            return jsonResponse({ success: false, error: "Pengguna sudah presensi hari ini." }, 409);
          }

          await env.DB.prepare(
            `INSERT INTO attendance (id, user_id, user_name, user_email, date, time, timestamp, status, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(body.id, body.userId, body.userName, body.userEmail, body.date, body.time, body.timestamp, body.status || "Hadir", body.method || "Scan Wajah").run();

          return jsonResponse({ success: true });
        }

        if (method === "DELETE") {
          await env.DB.prepare("DELETE FROM attendance").run();
          return jsonResponse({ success: true });
        }
      }

      // 5. PUT /api/settings
      if (pathname === "/api/settings" && method === "PUT") {
        const body = await request.json();
        await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'threshold'")
          .bind(String(body.threshold ?? 0.45)).run();
        return jsonResponse({ success: true });
      }

      // 6. POST /api/reset
      if (pathname === "/api/reset" && method === "POST") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM attendance"),
          env.DB.prepare("DELETE FROM users"),
          env.DB.prepare("UPDATE settings SET value = '0.45' WHERE key = 'threshold'"),
        ]);
        return jsonResponse({ success: true });
      }

      // 7. Sajikan index.html
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return jsonResponse({ success: false, error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  },
};
