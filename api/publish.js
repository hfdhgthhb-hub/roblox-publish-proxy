// Vercel serverless function: api/publish.js  (replace your old file with this one)
// Uses CommonJS so it works with no package.json changes.
const BASE = 'https://apis.roblox.com';

// Turn any string into a safe Luau string literal
function luaStr(s) {
  const bytes = Buffer.from(s, 'utf8');
  let out = '"';
  for (const c of bytes) {
    if (c === 34) out += '\\"';
    else if (c === 92) out += '\\\\';
    else if (c >= 32 && c < 127) out += String.fromCharCode(c);
    else out += '\\' + String(c).padStart(3, '0');
  }
  return out + '"';
}

// Turn Roblox error replies into short, readable messages
function cleanErr(text, status) {
  let j;
  try { j = JSON.parse(text); } catch (e) {}
  const msg = (j && (j.message || j.error)) || String(text).slice(0, 200);
  const code = j && j.code;
  if (code === 'PERMISSION_DENIED' || status === 403) {
    if (/luau-execution/.test(msg)) {
      return 'API key is missing the Luau Execution permission. Edit the key: add API System "Luau Execution", operation Write, and add this experience.';
    }
    return 'API key is missing a permission: ' + msg;
  }
  if (status === 401 || code === 'UNAUTHENTICATED') {
    return 'API key is invalid, expired, or has an IP restriction.';
  }
  if (status === 404) {
    return 'Not found. Check the Place ID and that the key has this experience added.';
  }
  return 'Roblox: ' + msg;
}

// Runs inside Roblox's cloud on the TARGET place
const CLOUD_BODY = `
local SKIP = { Terrain = true, Camera = true }

local function build(node, parent)
	local ok, inst = pcall(Instance.new, node.c)
	if not ok then return 0 end
	local n = 1
	pcall(function()
		inst.Name = node.n
		if node.size then
			inst.Size = Vector3.new(table.unpack(node.size))
			inst.CFrame = CFrame.new(table.unpack(node.cf))
			inst.Color = Color3.new(table.unpack(node.col))
			inst.Material = Enum.Material[node.mat]
			inst.Transparency = node.tr
			inst.Anchored = node.an
			inst.CanCollide = node.cc
			if node.shape then inst.Shape = Enum.PartType[node.shape] end
		end
	end)
	if node.src ~= nil then pcall(function() inst.Source = node.src end) end
	if node.dis ~= nil then pcall(function() inst.Disabled = node.dis end) end
	for _, child in ipairs(node.ch or {}) do
		n += build(child, inst)
	end
	inst.Parent = parent
	return n
end

local total = 0
for serviceName, nodes in pairs(data) do
	local service = game:GetService(serviceName)
	for _, child in ipairs(service:GetChildren()) do
		if not SKIP[child.Name] then pcall(function() child:Destroy() end) end
	end
	for _, node in ipairs(nodes) do
		total += build(node, service)
	end
end

AssetService:SavePlaceAsync()
return "saved " .. total .. " objects"
`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const b = req.body || {};
  const { action, apiKey } = b;
  if (!apiKey || typeof apiKey !== 'string') return res.json({ ok: false, error: 'Missing API key' });

  try {
    if (action === 'publish') {
      const placeId = String(b.placeId || '');
      if (!/^\d+$/.test(placeId)) return res.json({ ok: false, error: 'Place ID must be numbers only' });
      if (typeof b.build !== 'string' || !b.build) return res.json({ ok: false, error: 'No saved build' });

      // 1) place ID -> universe ID (public endpoint, no key needed)
      const uRes = await fetch(`${BASE}/universes/v1/places/${placeId}/universe`);
      if (!uRes.ok) return res.json({ ok: false, error: "Couldn't find that Place ID" });
      const { universeId } = await uRes.json();
      if (!universeId) return res.json({ ok: false, error: "Couldn't find that Place ID" });

      // 2) run the build + SavePlaceAsync in the cloud
      const script = [
        'local HttpService = game:GetService("HttpService")',
        'local AssetService = game:GetService("AssetService")',
        'local data = HttpService:JSONDecode(' + luaStr(b.build) + ')',
        CLOUD_BODY,
      ].join('\n');

      const tRes = await fetch(
        `${BASE}/cloud/v2/universes/${universeId}/places/${placeId}/luau-execution-session-tasks`,
        {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ script, timeout: '120s' }),
        }
      );
      if (!tRes.ok) return res.json({ ok: false, error: cleanErr(await tRes.text(), tRes.status) });
      const task = await tRes.json();

      // 3) optional name / description (best effort)
      let note = '';
      const fields = {};
      if (b.name) fields.displayName = String(b.name).slice(0, 50);
      if (b.description) fields.description = String(b.description).slice(0, 1000);
      const mask = Object.keys(fields);
      if (mask.length) {
        const pRes = await fetch(
          `${BASE}/cloud/v2/universes/${universeId}/places/${placeId}?updateMask=${mask.join(',')}`,
          {
            method: 'PATCH',
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(fields),
          }
        );
        if (!pRes.ok) note = " (name/description not changed: key needs Places write permission)";
      }
      return res.json({ ok: true, taskPath: task.path, note });
    }

    if (action === 'status') {
      const p = String(b.taskPath || '');
      if (!/^universes\/\d+\/places\/\d+\/[A-Za-z0-9_\-\/]+$/.test(p)) {
        return res.json({ ok: false, error: 'Bad task path' });
      }
      const r = await fetch(`${BASE}/cloud/v2/${p}`, { headers: { 'x-api-key': apiKey } });
      if (!r.ok) return res.json({ ok: false, error: cleanErr(await r.text(), r.status) });
      const t = await r.json();
      return res.json({
        ok: true,
        state: t.state,
        error: t.error ? (t.error.message || t.error.code || 'Task failed') : null,
        output: t.output || null,
      });
    }

    return res.json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    return res.json({ ok: false, error: String((e && e.message) || e) });
  }
};
