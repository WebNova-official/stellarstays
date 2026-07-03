// ==========================================
// STELLARSTAYS — BOOKING PAGE LOGIC
// booking.js
// ==========================================

let activeVilla = null;
let selectedTotalNights = 0;
let calendarInstance = null;

const CHEF_RATE_PER_DAY      = 4500;
const BONFIRE_RATE_PER_NIGHT = 1500;

// ==========================================
// API BASE — works for:
//   • localhost:5500 (Live Server)  → http://localhost:5000/api
//   • localhost:5000 (Node direct)  → /api
//   • stellar-stays.onrender.com    → /api
// ==========================================
function getApiBase() {
    const { hostname, port } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return port === '5000' ? '/api' : 'http://localhost:5000/api';
    }
    return '/api';
}

// ==========================================
// INIT
// ==========================================
async function parseUrlAndPopulate() {
    const urlParams   = new URLSearchParams(window.location.search);
    const villaId     = urlParams.get('id');
    const checkInStr  = urlParams.get('checkIn')  || '';
    const checkOutStr = urlParams.get('checkOut') || '';
    const adultsVal   = urlParams.get('adults')   || '1';
    const childrenVal = urlParams.get('children') || '0';
    const petsVal     = urlParams.get('pets')     || '0';

    if (!villaId) {
        alert("No property selected. Returning to listings.");
        window.location.href = "index.html";
        return;
    }

    try {
        const response = await fetch(`${getApiBase()}/properties/${villaId}`);
        if (!response.ok) throw new Error('Property not found');
        activeVilla = await response.json();
    } catch (error) {
        console.error('Error loading property:', error);
        alert("Property not found. Returning to listings.");
        window.location.href = "index.html";
        return;
    }

    // Populate text fields
    document.getElementById("detailVillaName").innerText     = activeVilla.name || "Unnamed Villa";
    document.getElementById("detailVillaLocation").innerText = activeVilla.location || "Location Not Available";
    document.getElementById("detailVillaRating").innerText   = (activeVilla.rating || 4.8).toFixed(1);
    document.getElementById("detailVillaRating2").innerText  = (activeVilla.rating || 4.8).toFixed(1);
    document.getElementById("detailVillaBeds").innerText     = `${activeVilla.bedrooms || 0} BHK`;
    document.getElementById("detailVillaGuests").innerText   = `Max ${activeVilla.guests || 0} Guests`;
    document.getElementById("stickyRatePrint").innerText     = `₹${(activeVilla.pricePerNight || 0).toLocaleString('en-IN')}`;
    document.getElementById("stickyRating").innerText        = (activeVilla.rating || 4.8).toFixed(1);

    const adultsNum   = parseInt(adultsVal);
    const childrenNum = parseInt(childrenVal);
    const petsNum     = parseInt(petsVal);
    document.getElementById("detailVillaAdults").innerText =
        `${adultsNum} Adult${adultsNum > 1 ? 's' : ''}${childrenNum > 0 ? ' + ' + childrenNum + ' Child' : ''}`;
    document.getElementById("detailVillaPets").innerText =
        petsNum > 0 ? `${petsNum} Pet${petsNum > 1 ? 's' : ''}` : 'No Pets';

    // Map
    const mapEl = document.getElementById("googleMapsEmbed");
    if (mapEl) mapEl.src = activeVilla.mapUrl || "";

    // Image gallery
    const sliderWrapper = document.getElementById("sliderWrapper");
    if (sliderWrapper) {
        sliderWrapper.innerHTML = (activeVilla.gallery || []).map(imgSrc => `
            <div class="swiper-slide">
                <a href="${imgSrc}" class="glightbox" data-gallery="stellar-gallery">
                    <img src="${imgSrc}" alt="${activeVilla.name}" class="w-full h-full object-cover cursor-zoom-in hover:brightness-95 transition" />
                </a>
            </div>
        `).join('');

        new Swiper('.mainVillaSlider', {
            loop: true,
            pagination: { el: '.swiper-pagination', clickable: true },
            navigation: { nextEl: '.swiper-button-next', prevEl: '.swiper-button-prev' },
            autoplay: { delay: 4500, disableOnInteraction: false },
        });
        if (typeof GLightbox !== 'undefined') {
            GLightbox({ selector: '.glightbox', touchNavigation: true, loop: true });
        }
    }

    // Amenities
    const amenityContainer = document.getElementById("amenityContainer");
    if (amenityContainer) {
        amenityContainer.innerHTML = (activeVilla.amenities || []).map(a => `
            <div class="flex items-center gap-2.5 text-xs font-semibold text-gray-700 bg-white p-3.5 rounded-xl border border-gray-100 shadow-sm hover:border-amber-200 transition">
                <i class="fa-solid fa-square-check text-amber-500 text-base"></i> ${a}
            </div>
        `).join('');
    }

    // Reviews
    const reviewsContainer = document.getElementById("reviewsContainer");
    if (reviewsContainer) {
        reviewsContainer.innerHTML = (activeVilla.reviews || []).map(rev => `
            <div class="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm space-y-2.5">
                <div class="flex justify-between items-center">
                    <div>
                        <h5 class="text-sm font-bold text-gray-900">${rev.author}</h5>
                        <span class="text-[10px] text-gray-400 font-medium">${rev.date}</span>
                    </div>
                    <span class="text-xs font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-md flex items-center gap-1 border border-amber-100">
                        <i class="fa-solid fa-star text-xs"></i> ${rev.score}
                    </span>
                </div>
                <p class="text-xs text-gray-500 leading-relaxed italic">"${rev.text}"</p>
            </div>
        `).join('');
    }

    // FAQs
    const faqContainer = document.getElementById("faqContainer");
    if (faqContainer) {
        faqContainer.innerHTML = (activeVilla.faqs || []).map(faq => `
            <div class="faq-item bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden" onclick="toggleFaqPanel(this)">
                <button class="w-full p-4 text-left flex justify-between items-center gap-4 text-sm font-bold text-[#0f1f3d] focus:outline-none">
                    <span>${faq.q}</span>
                    <i class="fa-solid fa-chevron-down text-xs text-gray-400 faq-icon transition-transform duration-300"></i>
                </button>
                <div class="faq-answer">
                    <p class="px-4 pb-4 pt-1 text-xs text-gray-500 leading-relaxed border-t border-gray-50 bg-gray-50/50">${faq.a}</p>
                </div>
            </div>
        `).join('');
    }

    // ── Fetch booked date ranges + admin-blocked dates to disable in calendar ──
    let disabledRanges = [];
    try {
        const bRes = await fetch(`${getApiBase()}/bookings`);
        if (bRes.ok) {
            const allBookings = await bRes.json();
            const bookedRanges = allBookings
                .filter(b =>
                    String(b.property || b.propertyId) === String(activeVilla._id) &&
                    !["cancelled", "Cancelled"].includes(b.status)
                )
                .map(b => ({ from: b.checkIn, to: b.checkOut }));
            disabledRanges.push(...bookedRanges);
        }
    } catch (e) {
        console.warn("Could not fetch booked ranges for calendar:", e);
    }

    // Also disable admin-blocked individual dates
    if (activeVilla.blockedDates && activeVilla.blockedDates.length) {
        disabledRanges.push(...activeVilla.blockedDates);
    }

    // Date picker — booked ranges disabled
    calendarInstance = flatpickr("#dateRangePicker", {
        mode: "range",
        minDate: "today",
        dateFormat: "d M Y",
        defaultDate: (checkInStr && checkOutStr) ? [checkInStr, checkOutStr] : null,
        disable: disabledRanges,
        onChange: function(dates) { processStayDuration(dates); }
    });

    if (checkInStr && checkOutStr) {
        setTimeout(() => {
            if (calendarInstance.selectedDates.length === 2) {
                processStayDuration(calendarInstance.selectedDates);
            }
        }, 100);
    } else {
        calculateTotal();
    }
}

// ==========================================
// FAQ TOGGLE
// ==========================================
function toggleFaqPanel(element) {
    const isActive = element.classList.contains("active");
    document.querySelectorAll(".faq-item").forEach(item => item.classList.remove("active"));
    if (!isActive) element.classList.add("active");
}

// ==========================================
// DATE / NIGHTS CALCULATION
// ==========================================
function processStayDuration(dates) {
    if (dates.length === 2) {
        const ms = Math.abs(dates[1].getTime() - dates[0].getTime());
        selectedTotalNights = Math.ceil(ms / (1000 * 60 * 60 * 24));
    } else {
        selectedTotalNights = 0;
    }
    calculateTotal();
}

// ==========================================
// PRICE CALCULATION
// ==========================================
function calculateTotal() {
    if (!activeVilla) return;

    const baseCost = (activeVilla.pricePerNight || 0) * selectedTotalNights;
    document.getElementById("baseLabel").innerText =
        selectedTotalNights > 0
            ? `Base Stay (₹${(activeVilla.pricePerNight || 0).toLocaleString('en-IN')} × ${selectedTotalNights} Night${selectedTotalNights > 1 ? 's' : ''})`
            : 'Base Accommodation Fee';
    document.getElementById("baseCost").innerText = `₹${baseCost.toLocaleString('en-IN')}`;

    let addons = 0;
    if (document.getElementById("addonChef").checked && selectedTotalNights > 0) {
        const chefCost = CHEF_RATE_PER_DAY * selectedTotalNights;
        addons += chefCost;
        document.getElementById("addonChefCost").innerText = `₹${chefCost.toLocaleString('en-IN')}`;
        document.getElementById("addonChefRow").classList.remove("hidden");
    } else {
        document.getElementById("addonChefRow").classList.add("hidden");
    }

    if (document.getElementById("addonBonfire").checked && selectedTotalNights > 0) {
        const bonfireCost = BONFIRE_RATE_PER_NIGHT * selectedTotalNights;
        addons += bonfireCost;
        document.getElementById("addonBonfireCost").innerText = `₹${bonfireCost.toLocaleString('en-IN')}`;
        document.getElementById("addonBonfireRow").classList.remove("hidden");
    } else {
        document.getElementById("addonBonfireRow").classList.add("hidden");
    }

    const subtotal = baseCost + addons;
    const gst      = Math.round(subtotal * 0.18);
    const total    = subtotal + gst;

    document.getElementById("taxCost").innerText    = `₹${gst.toLocaleString('en-IN')}`;
    document.getElementById("grandTotal").innerText = `₹${total.toLocaleString('en-IN')}`;
}

// ==========================================
// BOOKING SUBMIT
// ==========================================
async function executePaymentGateway() {
    const name  = document.getElementById("guestName").value.trim();
    const email = document.getElementById("guestEmail").value.trim();
    const phone = document.getElementById("guestPhone").value.trim();

    if (selectedTotalNights === 0) {
        alert("Please select your check-in and check-out dates before proceeding.");
        document.getElementById("dateRangePicker").focus();
        return;
    }
    if (!name)  { alert("Please enter your full name.");          document.getElementById("guestName").focus();  return; }
    if (!email || !email.includes('@')) { alert("Please enter a valid email address."); document.getElementById("guestEmail").focus(); return; }
    if (!phone || phone.replace(/\D/g, '').length < 10) { alert("Please enter a valid 10-digit WhatsApp number."); document.getElementById("guestPhone").focus(); return; }

    const baseCost  = (activeVilla.pricePerNight || 0) * selectedTotalNights;
    let addonsTotal = 0;
    const addons    = [];
    if (document.getElementById("addonChef").checked)    { addons.push("Chef");    addonsTotal += CHEF_RATE_PER_DAY * selectedTotalNights; }
    if (document.getElementById("addonBonfire").checked) { addons.push("Bonfire"); addonsTotal += BONFIRE_RATE_PER_NIGHT * selectedTotalNights; }
    const gst    = Math.round((baseCost + addonsTotal) * 0.18);
    const amount = baseCost + addonsTotal + gst;

    const dates    = calendarInstance.selectedDates;
    const checkIn  = dates[0] ? dates[0].toISOString().slice(0, 10) : '';
    const checkOut = dates[1] ? dates[1].toISOString().slice(0, 10) : '';

    const urlParams = new URLSearchParams(window.location.search);

    const payload = {
        propertyId:    activeVilla._id,
        propertyName:  activeVilla.name,
        guestName:     name,
        guestEmail:    email,
        guestPhone:    phone,
        checkIn,
        checkOut,
        nights:        selectedTotalNights,
        adults:        parseInt(urlParams.get('adults')   || '1'),
        children:      parseInt(urlParams.get('children') || '0'),
        pricePerNight: activeVilla.pricePerNight || 0,
        baseAmount:    baseCost,
        addons,
        addonAmount:   addonsTotal,
        addonsTotal,
        taxAmount:     gst,
        gst,
        totalAmount:   amount,
        amount,
        status:        'Pending',
        paid:          false,
    };

    const btn = document.querySelector('[onclick="executePaymentGateway()"]');
    if (btn) { btn.disabled = true; btn.innerText = 'Processing…'; }

    try {
        const res = await fetch(`${getApiBase()}/bookings`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
        });

        if (res.status === 409) {
            const err = await res.json();
            alert("❌ " + err.message);
            if (btn) { btn.disabled = false; btn.innerText = 'Confirm & Book'; }
            return;
        }

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || "Server error");
        }

        const data = await res.json();
        const bookingId = data.booking?._id || data.bookingId || '';
        window.location.href = `confirmation.html?bookingId=${bookingId}`;

    } catch (err) {
        alert("⚠️ Could not save booking: " + err.message + "\n\nPlease ensure the server is running.");
        if (btn) { btn.disabled = false; btn.innerText = 'Confirm & Book'; }
    }
}

// ==========================================
// INIT
// ==========================================
window.onload = () => { parseUrlAndPopulate(); };
