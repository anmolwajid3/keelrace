export default function ListToolbar({ search, onSearch, placeholder = 'Search…', children }) {
  return (
    <div className="list-toolbar">
      <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder} />
      {children}
    </div>
  )
}
