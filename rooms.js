/* 授業の教室名（ml/build_table.py の room_names と同じ規則）。 */

const ROOM_ALIASES = { "θ": "θ館" };

export function normalizeRoomName(roomName) {
    if (typeof roomName !== "string") return null;
    const normalized = roomName.normalize("NFKC").trim();
    if (!normalized) return null;
    return ROOM_ALIASES[normalized] || normalized;
}

export function getRoomNames(classInfo) {
    const locations =
        classInfo &&
        classInfo.classroom &&
        classInfo.classroom.locations;

    if (Array.isArray(locations)) {
        const rooms = locations
            .map(function (location) {
                return normalizeRoomName(location.room);
            })
            .filter(Boolean);

        if (rooms.length > 0) return Array.from(new Set(rooms));
    }

    const rawRoom =
        classInfo && classInfo.classroom
            ? classInfo.classroom.raw
            : classInfo && classInfo.CLRM;

    if (typeof rawRoom !== "string") return [];

    return Array.from(
        new Set(
            rawRoom
                .split(/[、,，/／・\s]+/)
                .map(normalizeRoomName)
                .filter(Boolean)
        )
    );
}

