// ==========================================
// STELLARSTAYS — INDEX PAGE LOGIC
// app.js
// ==========================================
let propertiesInventory = [];

// ==========================================
// NAVIGATION TO BOOKING PAGE
// ==========================================
function goToBooking(id) {
    const checkIn  = document.getElementById('startDateInput').value  || '';
    const checkOut = document.getElementById('endDateInput').value    || '';
    const guests   = document.getElementById('searchGuests').value    || '1';
    window.location.href = `booking.html?id=${id}&checkIn=${checkIn}&checkOut=${checkOut}&adults=${guests}`;
}

// ==========================================
// RENDER PROPERTIES
// ==========================================
function renderProperties(properties) {
    const grid      = document.getElementById("propertyGrid");
    const countText = document.getElementById("propertyCount");

    grid.innerHTML = "";
    countText.innerText = `${properties.length} ${properties.length === 1 ? 'space' : 'spaces'} available`;

    if (properties.length === 0) {
        grid.innerHTML = `
            <div class="col-span-full text-center py-16">
                <i class="fa-regular fa-folder-open text-4xl text-gray-300 mb-3 block"></i>
                <p class="text-gray-500 font-semibold text-sm">No properties found for this selection.</p>
                <button onclick="filterByLocation('all')" class="mt-4 text-xs font-bold text-indigo-700 underline">View all stays →</button>
            </div>`;
        return;
    }

    properties.forEach(item => {
        const amenitiesBadges = (item.amenities || []).slice(0, 2).map(a =>
            `<span class="bg-gray-100 text-gray-600 text-xs px-2.5 py-1 rounded-md font-medium">${a}</span>`
        ).join('');

        const hotBadge = item.hot
            ? `<span class="absolute top-3 left-3 hot-badge bg-red-500 text-white text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-wider shadow z-10">🔥 Hot Price</span>`
            : '';

        const directBadge = `<span class="absolute bottom-3 right-3 bg-teal-500/90 backdrop-blur-sm text-white text-[10px] font-bold px-2.5 py-1 rounded-md shadow z-10 flex items-center gap-1"><i class="fa-solid fa-bolt"></i> Direct Booking</span>`;

        const rawPrice      = item.pricePerNight || 0;
        const displayRating = item.rating ? item.rating : "4.8";

        const cardHTML = `
            <div onclick="goToBooking('${item._id}')" class="property-card bg-white rounded-2xl overflow-hidden border border-gray-100 flex flex-col cursor-pointer group">
                <div class="relative overflow-hidden aspect-[4/3] bg-gray-200">
                    <img src="${item.image || ''}" alt="${item.name || 'Property'}" class="card-img w-full h-full object-cover">
                    ${hotBadge}
                    <span class="absolute top-3 right-3 bg-white/90 backdrop-blur-sm text-gray-900 font-bold px-2.5 py-1 rounded-lg text-xs flex items-center gap-1 shadow-sm z-10">
                        <i class="fa-solid fa-star text-amber-500"></i> ${displayRating}
                    </span>
                    <span class="absolute bottom-3 left-3 bg-[#0f1f3d]/90 text-white text-xs font-semibold px-3 py-1 rounded-md shadow z-10">
                        📍 ${item.location || 'India'}
                    </span>
                    ${directBadge}
                </div>
                <div class="p-5 flex-1 flex flex-col justify-between">
                    <div>
                        <div class="flex items-center gap-3 text-xs text-gray-400 font-semibold uppercase tracking-wider mb-2">
                            <span><i class="fa-solid fa-users"></i> ${item.guests || 0} Guests</span>
                            <span>•</span>
                            <span><i class="fa-solid fa-bed"></i> ${item.bedrooms || 0} BHK</span>
                        </div>
                        <h4 class="text-base font-bold text-gray-900 group-hover:text-indigo-900 transition line-clamp-1 mb-3">${item.name || 'Boutique Stay'}</h4>
                        <div class="flex gap-1.5 flex-wrap mb-4">${amenitiesBadges}</div>
                    </div>
                    <div class="border-t border-gray-100 pt-4 flex justify-between items-center">
                        <div>
                            <span class="text-xl font-extrabold text-[#0f1f3d]">₹${rawPrice.toLocaleString('en-IN')}</span>
                            <span class="text-xs text-gray-400 font-medium"> / night</span>
                        </div>
                        <button class="bg-amber-50 border border-amber-200 text-amber-700 px-4 py-2 rounded-xl text-xs font-bold hover:bg-amber-500 hover:text-white hover:border-amber-500 transition shadow-sm">
                            View Details →
                        </button>
                    </div>
                </div>
            </div>`;
        grid.innerHTML += cardHTML;
    });
}

// ==========================================
// BUILD LOCATION FILTER PILLS FROM LIVE DATA
// ==========================================
function buildLocationPills(properties) {
    const container = document.getElementById("locationPills");
    if (!container) return;

    const locations = [...new Set(
        properties.map(p => p.location).filter(Boolean)
    )].sort();

    const pillClass = "location-btn shrink-0 px-5 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition whitespace-nowrap";

    let html = `<button onclick="filterByLocation('all')" class="${pillClass} loc-btn-active">🌍 All</button>`;
    locations.forEach(loc => {
        html += `<button onclick="filterByLocation('${loc}')" class="${pillClass} loc-btn-inactive">${loc}</button>`;
    });

    container.innerHTML = html;
}

// ==========================================
// LOCATION FILTER
// ==========================================
function filterByLocation(location) {
    const buttons = document.querySelectorAll(".location-btn");
    buttons.forEach(btn => {
        const text = btn.innerText.replace(/[^a-zA-Z\s]/g, '').trim().toLowerCase();
        const isActive = location === 'all'
            ? text.includes('all')
            : text === location.toLowerCase();
        btn.className = isActive
            ? "location-btn loc-btn-active shrink-0 px-5 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition whitespace-nowrap"
            : "location-btn loc-btn-inactive shrink-0 px-5 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition whitespace-nowrap";
    });

    document.getElementById("gridTitle").innerText = location === "all"
        ? "Featured Properties"
        : `Premium Stays in ${location}`;

    const filtered = location === "all"
        ? propertiesInventory
        : propertiesInventory.filter(p =>
            p.location && p.location.toLowerCase() === location.toLowerCase()
          );

    renderProperties(filtered);
}

// ==========================================
// SEARCH
// ==========================================
function handleSearch() {
    const textQuery  = document.getElementById("searchLocation").value.toLowerCase().trim();
    const guestQuery = parseInt(document.getElementById("searchGuests").value) || 1;

    const filtered = propertiesInventory.filter(p => {
        const matchesText = textQuery === "" ||
            (p.location && p.location.toLowerCase().includes(textQuery)) ||
            (p.name     && p.name.toLowerCase().includes(textQuery));
        const matchesGuests = (p.guests || 0) >= guestQuery;
        return matchesText && matchesGuests;
    });

    document.getElementById("gridTitle").innerText = textQuery !== ""
        ? `Results for "${textQuery}"`
        : "Search Results";
    renderProperties(filtered);
}

// ==========================================
// API BASE — works for:
//   • localhost:5500 (Live Server)  → http://localhost:5000/api
//   • localhost:5000 (Node direct)  → /api
//   • stellar-stays.onrender.com    → /api
// ==========================================
function getApiBase() {
    const { hostname, port } = window.location;

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return port === '5000'
            ? '/api'
            : 'http://localhost:5000/api';
    }

    return 'https://stellarstays.onrender.com/api';
}
async function loadProperties() {
    const API_BASE = getApiBase();
    const grid     = document.getElementById("propertyGrid");
    const count    = document.getElementById("propertyCount");

    grid.innerHTML = `<div class="col-span-full text-center py-16 text-gray-400 font-medium animate-pulse">Assembling your dream spaces…</div>`;
    count.innerText = "Loading…";

    try {
        console.log(`[StellarStays] Fetching properties from: ${API_BASE}/properties`);

        const response = await fetch(`${API_BASE}/properties`);
        if (!response.ok) throw new Error(`Server returned ${response.status}`);

        const all = await response.json();
        console.log(`[StellarStays] Loaded ${all.length} properties from DB`);

        propertiesInventory = all.filter(p => !p.status || p.status === "Active");
        console.log(`[StellarStays] Active properties: ${propertiesInventory.length}`);

        buildLocationPills(propertiesInventory);
        renderProperties(propertiesInventory);

    } catch (error) {
        console.error("[StellarStays] Failed to load properties:", error);

        grid.innerHTML = `
            <div class="col-span-full text-center py-16 space-y-3">
                <i class="fa-regular fa-circle-xmark text-4xl text-red-300 block"></i>
                <p class="text-red-500 font-semibold text-sm">Unable to load properties.</p>
                <p class="text-gray-400 text-xs">Make sure your Node.js server is running:<br>
                   <code class="bg-gray-100 px-2 py-0.5 rounded text-xs font-mono">node server.js</code>
                   &nbsp;(port 5000)
                </p>
                <button onclick="loadProperties()" class="mt-2 text-xs font-bold text-indigo-600 underline">↻ Retry</button>
            </div>`;
        count.innerText = "0 spaces available";

        const pills = document.getElementById("locationPills");
        if (pills) pills.innerHTML = `<span class="text-xs text-gray-300 font-medium">—</span>`;
    }
}

window.onload = loadProperties;
